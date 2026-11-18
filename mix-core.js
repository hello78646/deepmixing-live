export const MAX_SEGMENT_SECONDS = 180;
export const MIN_SEGMENT_SECONDS = 0.25;
const BLOCK = 131072;
const yieldFrame = () => new Promise(resolve => setTimeout(resolve, 0));

export function planMix(a, b, fadeSeconds, sampleRate) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error('不支持当前音频采样率。');
  const parts = [a, b].map(({start, end, length}, index) => {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end * sampleRate > length + 0.5) {
      throw new Error(`音轨 ${index ? 'B' : 'A'} 的起止点超出范围。`);
    }
    const from = Math.floor(start * sampleRate);
    const frames = Math.min(length, Math.round(end * sampleRate)) - from;
    if (frames < MIN_SEGMENT_SECONDS * sampleRate || frames > MAX_SEGMENT_SECONDS * sampleRate) {
      throw new Error(`音轨 ${index ? 'B' : 'A'} 请截取 0.25 至 180 秒。`);
    }
    return {from, frames};
  });
  if (!Number.isFinite(fadeSeconds) || fadeSeconds < 0.5 || fadeSeconds > 12) throw new Error('淡化时长须为 0.5 至 12 秒。');
  const fade = Math.min(Math.round(fadeSeconds * sampleRate), Math.floor(Math.min(...parts.map(p => p.frames)) / 2));
  return {parts, fade, bAt: parts[0].frames - fade, frames: parts[0].frames + parts[1].frames - fade, sampleRate};
}

export async function mixToWave(a, b, plan, progress = () => {}) {
  const {parts, fade, bAt, frames, sampleRate} = plan;
  const channels = [a,b].map(track => [track.getChannelData(0), track.getChannelData(track.numberOfChannels === 1 ? 0 : 1)]);
  const output = [new Float32Array(frames), new Float32Array(frames)];
  let peak = 0;
  const ramp = Math.max(1, Math.round(sampleRate * 0.008));
  for (let i = 0; i < frames; i++) {
    let ga, gb;
    if (i < bAt) { ga = 1; gb = 0; }
    else if (i < parts[0].frames) {
      const theta = ((i - bAt) / Math.max(fade - 1, 1)) * Math.PI / 2;
      ga = Math.cos(theta); gb = Math.sin(theta);
    } else { ga = 0; gb = 1; }
    const edge = Math.min(i / ramp, (frames - 1 - i) / ramp, 1);
    for (let ch = 0; ch < 2; ch++) {
      const sampleA = i < parts[0].frames ? channels[0][ch][i + parts[0].from] : 0;
      const sampleB = i >= bAt ? channels[1][ch][i - bAt + parts[1].from] : 0;
      const value = ((Number.isFinite(sampleA) ? sampleA : 0) * ga + (Number.isFinite(sampleB) ? sampleB : 0) * gb) * edge;
      output[ch][i] = value;
      peak = Math.max(peak, Math.abs(value));
    }
    if (i % BLOCK === 0) { progress(Math.round(70 * i / frames)); await yieldFrame(); }
  }
  // Attenuate only when needed so correlated sources cannot clip in the overlap.
  const scale = peak > 0.98 ? 0.98 / peak : 1;
  const bytes = new ArrayBuffer(44 + 4 * frames);
  const wav = new DataView(bytes);
  const ascii = (at, text) => [...text].forEach((c, i) => wav.setUint8(at + i, c.charCodeAt(0)));
  const u16 = (i, n) => wav.setUint16(i, n, true);
  const u32 = (i, n) => wav.setUint32(i, n, true);
  ascii(0, 'RIFF'); u32(4, bytes.byteLength - 8); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  u32(16, 16); u16(20, 1); u16(22, 2); u32(24, sampleRate); u32(28, sampleRate * 4);
  u16(32, 4); u16(34, 16); ascii(36, 'data'); u32(40, bytes.byteLength - 44);
  for (let i = 0; i < frames; i++) {
    wav.setInt16(44 + 4*i, Math.round(output[0][i] * scale * 32767), true);
    wav.setInt16(46 + 4*i, Math.round(output[1][i] * scale * 32767), true);
    if (i % BLOCK === 0) { progress(70 + Math.round(30 * i / frames)); await yieldFrame(); }
  }
  return new Blob([bytes], {type:'audio/wav'});
}

export function buildDemo(context, which) {
  const rate = context.sampleRate;
  const track = context.createBuffer(1, rate * 10, rate);
  const notes = which ? [293.66, 440, 587.33, 349.23, 523.25, 440, 392, 293.66] : [146.83, 220, 293.66, 174.61, 261.63, 220, 196, 146.83];
  const data = track.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / rate;
    const step = t % 0.25;
    const beat = t % 0.5;
    const p = 2 * Math.PI * notes[Math.floor(t * 4) % notes.length] * step;
    const tone = (Math.sin(p) + 0.25*Math.sin((which ? 3 : 2)*p)) * Math.exp(-step*11) * Math.min(1, step*270);
    const kick = Math.sin(2*Math.PI*(46*beat + 3*(1-Math.exp(-beat*18)))) * Math.exp(-beat*17);
    data[i] = 0.22*tone + (which ? 0.23 : 0.16)*kick;
  }
  return track;
}

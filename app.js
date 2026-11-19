import {buildDemo, MAX_SEGMENT_SECONDS, MIN_SEGMENT_SECONDS, mixToWave, planMix} from './mix-core.js';

const maxBytes = 35 * 1024 * 1024;
const maxSourceSeconds = 8 * 60;
const $ = id => document.getElementById(id);
const demo = $('demo'), mix = $('mix'), download = $('download'), status = $('status');
const player = $('player'), result = $('result'), fade = $('fade'), fadeValue = $('fade-value');
const decks = Array.from(document.querySelectorAll('.deck'), (node, index) => ({
  file: node.querySelector('input[type=file]'), title: node.querySelector('.name'), note: node.querySelector('.track-note'),
  trim: node.querySelector('.trim'), start: node.querySelector('.start'), end: node.querySelector('.end'),
  defaultTitle: index ? '选择第二段音频' : '选择第一段音频', buffer:null, loading:false,
}));
let context, busy = false, outputUrl;
const secs = n => new Intl.NumberFormat('zh-CN', {maximumFractionDigits:2}).format(n);

function showStatus(message, error = false) {
  status.textContent = message;
  status.toggleAttribute('data-error', error);
}
function getContext() {
  if (context) return context;
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline) throw new Error('当前浏览器不支持音频处理，请在 Chrome、Edge 或 Safari 中打开。');
  context = new Offline(2, 1, 44100);
  return context;
}
function setControls() {
  const loading = decks.some(deck => deck.loading);
  demo.disabled = busy || loading;
  mix.disabled = busy || loading || decks.some(deck => !deck.buffer);
  fade.disabled = busy;
  for (const deck of decks) deck.file.disabled = deck.start.disabled = deck.end.disabled = busy || deck.loading;
}
function discardMix() {
  if (!outputUrl) return;
  player.pause();
  player.removeAttribute('src');
  player.load();
  download.removeAttribute('href');
  download.hidden = result.hidden = true;
  URL.revokeObjectURL(outputUrl);
  outputUrl = undefined;
}
function loadDeck(deck, buffer, label) {
  deck.buffer = buffer;
  deck.title.textContent = label || deck.defaultTitle;
  deck.trim.hidden = !buffer;
  if (!buffer) { deck.note.textContent = 'MP3、WAV 或浏览器支持的音频格式'; return; }
  deck.start.value = '0';
  deck.start.max = deck.end.max = String(buffer.duration);
  deck.end.value = String(Math.min(buffer.duration, MAX_SEGMENT_SECONDS));
  deck.note.textContent = `总长 ${secs(buffer.duration)} 秒 · 每轨最多选 180 秒`;
}
async function readFile(deck, file) {
  if (!file || deck.loading || busy) return;
  if (!file.size || file.size > maxBytes) {
    showStatus('文件为空或超过 35 MiB，现有音轨未更换。', true);
    return;
  }
  deck.loading = true;
  showStatus('正在读取音频…');
  setControls();
  try {
    const buffer = await getContext().decodeAudioData(await file.arrayBuffer());
    if (buffer.duration < MIN_SEGMENT_SECONDS || buffer.duration > maxSourceSeconds) {
      showStatus('请选择时长在 0.25 秒到 8 分钟之间的音频，现有音轨未更换。', true);
      return;
    }
    discardMix();
    loadDeck(deck, buffer, file.name);
    showStatus(decks.every(d => d.buffer) ? '双轨就绪。可以调交叉淡化，再生成试听。' : '已载入一段，还差另一段。');
  } catch (error) {
    showStatus(error.name === 'Error' ? error.message : '读不出这份音频。请试试 MP3 或 WAV。', true);
  } finally { deck.loading = false; setControls(); }
}
for (const deck of decks) {
  deck.file.addEventListener('change', () => {
    const file = deck.file.files[0];
    deck.file.value = '';
    void readFile(deck, file);
  });
  for (const control of [deck.start, deck.end]) control.addEventListener('input', parametersChanged);
}
function parametersChanged() {
  if (outputUrl) { discardMix(); showStatus('交接设置已改动，请重新生成试听。'); }
}
fade.addEventListener('input', () => {fadeValue.value = `${secs(Number(fade.value))} 秒`; parametersChanged();});
demo.addEventListener('click', () => {
  if (decks.some(deck => deck.buffer) && !window.confirm('示例会替换当前选中的音轨。要继续吗？')) return;
  try {
    const audio = getContext();
    const examples = [buildDemo(audio, 0), buildDemo(audio, 1)];
    discardMix();
    decks.forEach((deck,index) => loadDeck(deck, examples[index], index ? '示例 B · 霓虹回声' : '示例 A · 月面节拍'));
    showStatus('两段原创合成示例已就绪。点击「生成试听」。');
    setControls();
  } catch (error) { showStatus(error.message, true); }
});
mix.addEventListener('click', async () => {
  if (mix.disabled) return;
  busy = true;
  discardMix();
  setControls();
  try {
    const [a,b] = decks.map(deck => ({start:deck.start.valueAsNumber, end:deck.end.valueAsNumber, length:deck.buffer.length}));
    const plan = planMix(a,b,Number(fade.value),getContext().sampleRate);
    let lastProgress = -10;
    const blob = await mixToWave(decks[0].buffer,decks[1].buffer,plan,value => {
      if (value >= lastProgress + 10) { showStatus(`正在混音 · ${value}%`); lastProgress = value; }
    });
    outputUrl = URL.createObjectURL(blob);
    player.src = download.href = outputUrl;
    result.hidden = download.hidden = false;
    showStatus(`完成：总长 ${secs(plan.frames / plan.sampleRate)} 秒，实际交叉淡化 ${secs(plan.fade / plan.sampleRate)} 秒。`);
  } catch (error) { showStatus(error.message || '无法生成，请缩短所选音频。', true); }
  finally { busy = false; setControls(); }
});
player.addEventListener('error', () => { if (outputUrl) showStatus('浏览器不能播放此音频，可下载 WAV 后试听。', true); });

// Enable only when the release includes a cleared, prerecorded opening clip.
const openingButton = $('opening-voice');
if (openingButton?.dataset.src) {
  const opening = new Audio(openingButton.dataset.src);
  let attempt = 0, active = false;
  function stopOpening() {
    attempt++;
    active = false;
    opening.pause();
    if (!openingButton.disabled) openingButton.textContent = '播放零氪开场';
  }
  async function playOpening() {
    const current = ++attempt;
    active = true;
    openingButton.textContent = '停止开场语音';
    try {
      opening.currentTime = 0;
      await opening.play();
    } catch (error) {
      if (current !== attempt) return;
      stopOpening();
      if (error.name !== 'NotAllowedError') {
        openingButton.textContent = '开场语音暂不可用';
        openingButton.disabled = true;
      }
    }
  }
  opening.addEventListener('ended', stopOpening);
  openingButton.addEventListener('click', () => {
    if (active) stopOpening();
    else { player.pause(); void playOpening(); }
  });
  player.addEventListener('play', stopOpening);
  window.addEventListener('pagehide', stopOpening);
  $('opening-voice-panel').hidden = false;
  void playOpening();
}

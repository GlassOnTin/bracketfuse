// BracketFuse main thread: decode, meter, drive the worker, export.
// Everything heavy lives in worker.js.
import { encodeHDR } from './rgbe.js';

const $ = (id) => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), strip = $('strip'), status = $('status');
const bar = $('bar'), barFill = bar.firstElementChild, out = $('out'), exports = $('exports');
const go = $('go'), method = $('method');

// Measured in desktop Chrome on this OpenCV build: MergeMertens completes at
// 3x10, 5x6 and 9x4 MP but runs the wasm heap out at 5x8 MP, and the heap does
// not recover afterwards — the worker has to be thrown away. Auto mode stays
// inside the envelope; anything that still fails retries smaller.
const BUDGET_MP = 30, PER_IMAGE_MP = 8;
const autoCap = (n) => Math.max(0.5, Math.min(PER_IMAGE_MP, BUDGET_MP / n));

let shots = [];      // { file, bitmap, time, iso, fnum, label }
let worker = null, busy = false, lastResult = null, hasHdr = false;

// --- worker plumbing ------------------------------------------------------

function spawn() {
  if (worker) worker.terminate();
  worker = new Worker('worker.js');
  worker.onmessage = (e) => (handlers[e.data.type] || (() => {}))(e.data);
  worker.onerror = (e) => fail(e.message || 'Worker crashed.');
  return worker;
}

const ask = (msg, transfer) => worker.postMessage(msg, transfer || []);

const handlers = {
  progress: ({ pct, msg }) => setProgress(pct, msg),
  result: (m) => finish(m),
  hdrData: (m) => saveHdr(m),
  error: (m) => (m.oom ? retrySmaller(m) : fail(m.message)),
  pushed: () => {},
  ready: () => {},
  reset: () => {},
};

// --- input ----------------------------------------------------------------

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && fileInput.click());
fileInput.addEventListener('change', () => add([...fileInput.files]));
for (const ev of ['dragenter', 'dragover']) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
}
drop.addEventListener('drop', (e) => add([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))));

$('clear').addEventListener('click', reset);

async function add(files) {
  if (!files.length || busy) return;
  say(`Reading ${files.length} file${files.length > 1 ? 's' : ''}…`);
  for (const file of files) {
    if (shots.length >= 9) { say('Stack limited to 9 frames.'); break; }
    try {
      shots.push(await load(file));
    } catch (err) {
      say(`Could not read ${file.name}: ${err.message}`, true);
    }
  }
  // Ascending exposure reads naturally left-to-right; Mertens is order-agnostic
  // but MergeDebevec pairs each frame with its time, so keep the two together.
  shots.sort((a, b) => (a.time ?? a.lum) - (b.time ?? b.lum));
  render();
}

async function load(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let time = null, iso = null, fnum = null;
  try {
    // No tag picker: the lite exifr bundle ships without the tag-name
    // dictionary the array form needs, and throws on it.
    const x = await exifr.parse(file);
    if (x) ({ ExposureTime: time = null, ISO: iso = null, FNumber: fnum = null } = x);
  } catch { /* no EXIF is normal for screenshots and edited files */ }
  return { file, bitmap, time, iso, fnum, lum: meter(bitmap) };
}

// Mean luminance of a 32px thumbnail — used to order frames when EXIF is absent.
function meter(bitmap) {
  const c = new OffscreenCanvas(32, 32);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return sum / (d.length / 4);
}

const shutter = (t) => (t == null ? null : t >= 1 ? `${t}s` : `1/${Math.round(1 / t)}`);

function render() {
  strip.innerHTML = '';
  for (const s of shots) {
    const c = document.createElement('canvas');
    c.width = 108; c.height = 81;
    c.getContext('2d').drawImage(s.bitmap, 0, 0, 108, 81);
    const fig = document.createElement('figure');
    const img = new Image();
    img.src = c.toDataURL();
    img.alt = s.file.name;
    const bits = [shutter(s.time), s.fnum && `f/${s.fnum}`, s.iso && `ISO ${s.iso}`].filter(Boolean);
    fig.append(img, Object.assign(document.createElement('figcaption'), {
      textContent: bits.join(' · ') || `${(s.bitmap.width * s.bitmap.height / 1e6).toFixed(1)} MP`,
    }));
    strip.append(fig);
  }
  go.disabled = shots.length < 2;
  $('clear').hidden = !shots.length;
  const timed = shots.filter((s) => s.time > 0).length;
  if (shots.length >= 2) {
    say(`${shots.length} frames · ${timed === shots.length ? 'exposure times found' : `${timed}/${shots.length} have exposure times`}`);
  } else if (shots.length === 1) {
    say('Add at least one more exposure.');
  }
}

function reset() {
  shots.forEach((s) => s.bitmap.close());
  shots = [];
  lastResult = null; hasHdr = false;
  strip.innerHTML = ''; out.style.display = 'none'; exports.hidden = true;
  fileInput.value = '';
  render();
  say('');
}

// --- merge ----------------------------------------------------------------

go.addEventListener('click', () => { downscaled = false; merge(chosenCap()); });

function chosenCap() {
  const v = Number($('cap').value);
  return v === 0 ? autoCap(shots.length) : v === 99 ? Infinity : v;
}

function options() {
  return {
    align: $('doAlign').checked,
    method: method.value,
    contrast: +$('contrast').value,
    saturation: method.value === 'hdr' ? +$('hsat').value : +$('saturation').value,
    exposure: +$('exposure').value,
    tonemap: $('tonemap').value,
    gamma: +$('gamma').value,
    bias: +$('bias').value,
    intensity: +$('bias').value * 8 - 4,   // Reinhard intensity lives in -8..8
    scale: 0.7, lightAdapt: 1, colorAdapt: 0,
  };
}

let attemptCap = 0;

async function merge(capMP) {
  if (busy || shots.length < 2) return;
  busy = true; attemptCap = capMP;
  go.disabled = true; exports.hidden = true;
  bar.classList.add('on');
  setProgress(1, 'Starting engine…');

  spawn();
  const opts = options();
  if (opts.method === 'hdr' && !shots.every((s) => s.time > 0)) {
    opts.method = 'fusion';
    say('No exposure times in EXIF — using exposure fusion instead.');
  }

  for (const [i, s] of shots.entries()) {
    setProgress(2 + (6 * i) / shots.length, `Preparing frame ${i + 1} of ${shots.length}…`);
    const { data, width, height } = raster(s.bitmap, capMP);
    ask({ type: 'push', rgba: data.buffer, w: width, h: height, time: s.time }, [data.buffer]);
    await new Promise((r) => setTimeout(r, 0)); // let the worker drain between frames
  }
  ask({ type: 'run', opts });
}

// Decode to RGBA at or below the megapixel cap.
function raster(bitmap, capMP) {
  const mp = (bitmap.width * bitmap.height) / 1e6;
  const k = mp > capMP ? Math.sqrt(capMP / mp) : 1;
  const width = Math.max(1, Math.round(bitmap.width * k));
  const height = Math.max(1, Math.round(bitmap.height * k));
  const c = new OffscreenCanvas(width, height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0, width, height);
  return g.getImageData(0, 0, width, height);
}

let downscaled = false;

function retrySmaller({ message }) {
  const next = attemptCap === Infinity ? PER_IMAGE_MP : attemptCap * 0.6;
  if (next < 0.5) return fail('Out of memory even at the smallest size. Try fewer frames.');
  console.warn(`BracketFuse: ${message} — retrying at ${next.toFixed(1)} MP/frame`);
  downscaled = true;
  busy = false;
  merge(next); // spawns a fresh worker; the exhausted heap cannot be reused
}

function finish({ rgba, w, h, ms, shifts, hasHdr: gotHdr }) {
  out.width = w; out.height = h;
  out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  out.style.display = 'block';
  lastResult = { w, h };
  hasHdr = gotHdr;
  $('dlHdr').hidden = !gotHdr;
  exports.hidden = false;
  bar.classList.remove('on');
  busy = false; go.disabled = false;
  const moved = shifts ? shifts.filter(([x, y]) => x || y).length : 0;
  say(`Merged ${shots.length} frames to ${w}×${h} in ${(ms / 1000).toFixed(1)}s` +
      (shifts ? ` · realigned ${moved} of ${shifts.length}` : '') +
      (downscaled ? ' · downscaled to fit available memory' : ''));
  downscaled = false;
}

function fail(message) {
  bar.classList.remove('on');
  busy = false; go.disabled = shots.length < 2;
  say(message, true);
}

function setProgress(pct, msg) {
  barFill.style.width = `${Math.min(100, pct)}%`;
  if (msg) say(msg);
}

function say(text, isError) {
  status.textContent = text;
  status.classList.toggle('err', !!isError);
}

// --- export ---------------------------------------------------------------

const stem = () => (shots[0]?.file.name.replace(/\.[^.]+$/, '') || 'bracketfuse') + '-fused';

function download(blob, ext) {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob), download: `${stem()}.${ext}`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$('dlJpg').addEventListener('click', () => out.toBlob((b) => download(b, 'jpg'), 'image/jpeg', 0.92));
$('dlPng').addEventListener('click', () => out.toBlob((b) => download(b, 'png'), 'image/png'));
$('dlHdr').addEventListener('click', () => hasHdr && ask({ type: 'hdr' }));

function saveHdr({ data, w, h }) {
  const bytes = encodeHDR(new Float32Array(data), w, h);
  download(new Blob([bytes], { type: 'image/vnd.radiance' }), 'hdr');
}

// Show only the controls that apply to the chosen method.
method.addEventListener('change', () => {
  for (const el of document.querySelectorAll('#adv [data-when]')) {
    el.hidden = el.dataset.when !== method.value;
  }
});

for (const r of document.querySelectorAll('#adv input[type=range]')) {
  const show = () => (r.parentElement.querySelector('output').value = (+r.value).toFixed(2));
  r.addEventListener('input', show);
  show();
}

if (!window.Worker || !window.OffscreenCanvas || !window.createImageBitmap) {
  say('This browser is missing Web Workers or OffscreenCanvas — try a current Chrome, Firefox, or Safari.', true);
  go.disabled = true;
}

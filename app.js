// BracketFuse main thread: decode, meter, drive the worker, export.
// Everything heavy lives in worker.js.

// Carry this module's ?v= on to everything it loads. A static import would
// resolve against the base URL and drop the query, so rgbe.js is pulled in
// dynamically at the point of use instead — which also means it is only
// fetched if someone actually exports a .hdr.
const V = new URL(import.meta.url).search;

const $ = (id) => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), strip = $('strip'), status = $('status');
const bar = $('bar'), barFill = bar.firstElementChild, out = $('out'), exports = $('exports');
const compare = $('compare'), before = $('before'), wipe = $('wipe'), handle = $('handle');
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
  worker = new Worker('worker.js' + V);
  // A throw inside a handler would otherwise vanish into the console — and
  // leave the UI stuck mid-merge with no explanation.
  worker.onmessage = (e) => {
    try {
      (handlers[e.data.type] || (() => {}))(e.data);
    } catch (err) {
      fail(`Failed handling ${e.data.type}: ${err.message}`);
    }
  };
  worker.onerror = (e) => fail(e.message || 'Worker crashed.');
  worker.onmessageerror = () => fail('Lost a message from the worker (could not be copied between threads).');
  return worker;
}

const ask = (msg, transfer) => worker.postMessage(msg, transfer || []);

const handlers = {
  progress: ({ pct, msg }) => setProgress(pct, msg),
  result: (m) => finish(m),
  // async now that the encoder is loaded on demand, so catch it explicitly
  // rather than leaning on the global unhandled-rejection net.
  hdrData: (m) => saveHdr(m).catch((e) => fail(`Could not build the .hdr: ${e.message}`)),
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
  let time = null, iso = null, fnum = null, when = null;
  try {
    // No tag picker: the lite exifr bundle ships without the tag-name
    // dictionary the array form needs, and throws on it.
    const x = await exifr.parse(file);
    if (x) ({ ExposureTime: time = null, ISO: iso = null, FNumber: fnum = null,
              DateTimeOriginal: when = null } = x);
  } catch { /* no EXIF is normal for screenshots and edited files */ }
  return { file, bitmap, time, iso, fnum, when, lum: meter(bitmap) };
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
    const base = `${shots.length} frames · ${timed === shots.length ? 'exposure times found' : `${timed}/${shots.length} have exposure times`}`;
    const warn = advisory();
    say(base + (warn.length ? ' · ' + warn.join(' · ') : ''), warn.length > 0);
  } else if (shots.length === 1) {
    say('Add at least one more exposure.');
  }
}

// Exposure fusion has no deghosting: a subject that moves between frames comes
// out as stacked translucent copies. Both conditions below make that likely and
// are cheap to spot from EXIF, so say so before the user spends a merge on it.
function advisory() {
  const notes = [];
  const stamps = shots.map((s) => s.when && +s.when).filter(Boolean);
  if (stamps.length >= 2) {
    const span = (Math.max(...stamps) - Math.min(...stamps)) / 1000;
    if (span > 3) notes.push(`spans ${span < 60 ? `${span.toFixed(0)}s` : `${(span / 60).toFixed(1)} min`} — moving subjects will ghost`);
  }
  const et = shots.map((s) => s.time).filter(Boolean);
  if (new Set(et).size < et.length) notes.push('exposure times repeat — this looks like more than one bracket');
  return notes;
}

function reset() {
  shots.forEach((s) => s.bitmap.close());
  shots = [];
  lastResult = null; hasHdr = false;
  strip.innerHTML = ''; compare.hidden = true; exports.hidden = true;
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
    deghost: $('doDeghost').checked,
    ghostK: 3,
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

  // Everything below is async, so an unguarded throw here becomes an unhandled
  // rejection: nothing on screen and the UI stuck with the button disabled.
  // Preparing frames allocates a full-size canvas per frame, which is exactly
  // where a phone runs out of memory.
  try {
    for (const [i, s] of shots.entries()) {
      setProgress(2 + (6 * i) / shots.length, `Preparing frame ${i + 1} of ${shots.length}…`);
      const { data, width, height } = raster(s.bitmap, capMP);
      ask({ type: 'push', rgba: data.buffer, w: width, h: height, time: s.time }, [data.buffer]);
      await new Promise((r) => setTimeout(r, 0)); // let the worker drain between frames
    }
    ask({ type: 'run', opts });
  } catch (err) {
    if (/memory|allocat/i.test(err.message || '')) retrySmaller({ message: err.message });
    else fail(`Could not prepare the frames: ${err.message}`);
  }
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

function finish({ rgba, w, h, ms, shifts, ghosted, refIdx, hasHdr: gotHdr }) {
  out.width = w; out.height = h;
  out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  showBefore(refIdx, w, h);
  compare.hidden = false;
  lastResult = { w, h };
  hasHdr = gotHdr;
  $('dlHdr').hidden = !gotHdr;
  exports.hidden = false;
  bar.classList.remove('on');
  busy = false; go.disabled = false;
  const moved = shifts ? shifts.filter((s) => s.x || s.y || s.deg).length : 0;
  const maxDeg = shifts ? Math.max(0, ...shifts.map((s) => Math.abs(s.deg))) : 0;
  say(`Merged ${shots.length} frames to ${w}×${h} in ${(ms / 1000).toFixed(1)}s` +
      (shifts ? ` · realigned ${moved} of ${shifts.length}` : '') +
      (maxDeg >= 0.02 ? ` (up to ${maxDeg.toFixed(2)}° rotation)` : '') +
      (ghosted != null ? ` · ghosts replaced over ${ghosted.toFixed(1)}% of frame` : '') +
      (downscaled ? ' · downscaled to fit available memory' : ''));
  // Past roughly a quarter of the frame the output is mostly one exposure, which
  // defeats the point of bracketing — say so rather than quietly returning it.
  if (ghosted > 25) {
    say(status.textContent + ' — that is a lot; the result is close to a single exposure. ' +
        'Try frames taken closer together, or untick Remove ghosts.', true);
  }
  downscaled = false;
}

// The "before" panel is the reference frame at output size. Drawing it from the
// bitmap already in memory costs nothing extra, and because alignment leaves the
// reference unwarped it lines up with the result exactly.
function showBefore(refIdx, w, h) {
  const shot = shots[refIdx];
  if (!shot) { before.hidden = true; return; }
  before.hidden = false;
  before.width = w; before.height = h;
  before.getContext('2d').drawImage(shot.bitmap, 0, 0, w, h);
  $('tagBefore').textContent = shutter(shot.time) ? `before · ${shutter(shot.time)}` : 'before';
  setWipe(wipe.value);
}

function setWipe(pct) {
  before.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  handle.style.left = `${pct}%`;
}

wipe.addEventListener('input', () => setWipe(wipe.value));

// Pointer dragging is handled here rather than by the range input, so the
// divider lands exactly under the finger or cursor.
function wipeFrom(clientX) {
  const r = compare.getBoundingClientRect();
  if (!r.width) return;
  wipe.value = Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100));
  setWipe(wipe.value);   // read back, so the handle and the input agree after rounding
}
let wiping = false;
compare.addEventListener('pointerdown', (e) => {
  wiping = true;
  try { compare.setPointerCapture(e.pointerId); } catch { /* capture is a bonus */ }
  wipeFrom(e.clientX);
});
// Accept a held button as well as our own capture: pointer capture is not
// guaranteed (and a press that began outside the image still arrives here as a
// move with buttons set), so relying on it alone silently drops drags.
compare.addEventListener('pointermove', (e) => {
  if (wiping || (e.buttons & 1)) wipeFrom(e.clientX);
});
for (const ev of ['pointerup', 'pointercancel']) {
  window.addEventListener(ev, () => { wiping = false; });
}

function fail(message) {
  bar.classList.remove('on');
  busy = false; go.disabled = shots.length < 2;
  say(message, true);
  window.__bf?.record?.('app', message);   // also logs it for "Copy error details"
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

// toBlob hands back null when the browser cannot encode — usually a canvas too
// large for the device. Without this the failure is a silent no-op on click.
const save = (ext, type, q) => out.toBlob((b) => {
  if (b) download(b, ext);
  else fail(`Could not encode the ${ext.toUpperCase()} — the image may be too large for this device. Try a smaller size.`);
}, type, q);

$('dlJpg').addEventListener('click', () => save('jpg', 'image/jpeg', 0.92));
$('dlPng').addEventListener('click', () => save('png', 'image/png'));
$('dlHdr').addEventListener('click', () => hasHdr && ask({ type: 'hdr' }));

async function saveHdr({ data, w, h }) {
  const { encodeHDR } = await import('./rgbe.js' + V);
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

// Tells the startup watchdog in index.html that the module graph loaded and ran.
window.__bf.booted = true;

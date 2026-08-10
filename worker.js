// BracketFuse worker: everything OpenCV happens here so the UI never blocks.
importScripts('vendor/opencv.js');

let cv = null;
const stack = [];   // { mat: CV_8UC3, time: exposure seconds | null }
let hdr = null;     // CV_32FC3 radiance map from the Debevec path, kept for .hdr export

const post = (m, transfer) => self.postMessage(m, transfer || []);
const progress = (pct, msg) => post({ type: 'progress', pct, msg });

// OpenCV throws a raw wasm pointer, not an Error.
function describe(err) {
  if (typeof err === 'number' && cv && cv.exceptionFromPtr) {
    try { return cv.exceptionFromPtr(err).msg; } catch { return 'wasm exception ' + err; }
  }
  return (err && err.message) || String(err);
}
const isOOM = (s) => /Insufficient memory|OutOfMemory|allocat|out of memory/i.test(s);

function free() {
  stack.forEach((s) => s.mat.delete());
  stack.length = 0;
  if (hdr) { hdr.delete(); hdr = null; }
}

// --- pipeline steps -------------------------------------------------------

// AlignMTB's process(src, dst, ...) never writes to the dst MatVector through
// the JS bindings, so drive the shift search directly. Reference is the middle
// frame, which is the closest to a normal exposure.
function align() {
  const ref = stack[Math.floor(stack.length / 2)];
  const mtb = new cv.AlignMTB(6, 4, true);
  const grayRef = new cv.Mat();
  cv.cvtColor(ref.mat, grayRef, cv.COLOR_RGB2GRAY);
  const shifts = [];
  for (let i = 0; i < stack.length; i++) {
    if (stack[i] === ref) { shifts.push([0, 0]); continue; }
    progress(10 + (25 * i) / stack.length, `Aligning frame ${i + 1}…`);
    const gray = new cv.Mat();
    cv.cvtColor(stack[i].mat, gray, cv.COLOR_RGB2GRAY);
    const s = mtb.calculateShift(grayRef, gray);
    gray.delete();
    const out = new cv.Mat();
    mtb.shiftMat(stack[i].mat, out, s);
    stack[i].mat.delete();
    stack[i].mat = out;
    shifts.push([s.x, s.y]);
  }
  grayRef.delete();
  mtb.delete();
  return shifts;
}

function vecOf() {
  const v = new cv.MatVector();
  stack.forEach((s) => v.push_back(s.mat));
  return v;
}

function fuse(vec, opts) {
  const m = new cv.MergeMertens(opts.contrast, opts.saturation, opts.exposure);
  const out = new cv.Mat();
  m.process1(vec, out); // 2-arg overload; process() is the 4-arg base signature
  m.delete();
  return out; // CV_32FC3, nominally 0..1
}

function trueHdr(vec, opts) {
  const times = cv.matFromArray(stack.length, 1, cv.CV_32F, stack.map((s) => s.time));
  progress(45, 'Calibrating camera response…');
  const resp = new cv.Mat();
  const cal = opts.robertson ? new cv.CalibrateRobertson() : new cv.CalibrateDebevec();
  cal.process(vec, resp, times);
  cal.delete();

  progress(65, 'Building radiance map…');
  hdr = new cv.Mat();
  const merge = opts.robertson ? new cv.MergeRobertson() : new cv.MergeDebevec();
  merge.process(vec, hdr, times, resp);
  merge.delete();
  resp.delete();
  times.delete();

  progress(80, 'Tone mapping…');
  const t = { drago: () => new cv.TonemapDrago(opts.gamma, opts.saturation, opts.bias),
              mantiuk: () => new cv.TonemapMantiuk(opts.gamma, opts.scale, opts.saturation),
              reinhard: () => new cv.TonemapReinhard(opts.gamma, opts.intensity, opts.lightAdapt, opts.colorAdapt) }
            [opts.tonemap] || (() => new cv.Tonemap(opts.gamma));
  const op = t();
  const out = new cv.Mat();
  op.process(hdr, out);
  op.delete();
  return out;
}

// CV_32FC3 in 0..1 -> RGBA bytes the main thread can put straight on a canvas.
function toRGBA(f32) {
  const u8 = new cv.Mat();
  f32.convertTo(u8, cv.CV_8UC3, 255);
  const rgba = new cv.Mat();
  cv.cvtColor(u8, rgba, cv.COLOR_RGB2RGBA);
  u8.delete();
  const buf = new Uint8ClampedArray(rgba.data).buffer; // copy out before the Mat dies
  const dims = { w: rgba.cols, h: rgba.rows };
  rgba.delete();
  return { buf, ...dims };
}

// --- message handling -----------------------------------------------------

const ops = {
  push({ rgba, w, h, time }) {
    const src = cv.matFromArray(h, w, cv.CV_8UC4, new Uint8Array(rgba));
    const rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    src.delete();
    stack.push({ mat: rgb, time });
    post({ type: 'pushed', n: stack.length });
  },

  run(msg) {
    const opts = msg.opts;
    if (stack.length < 2) throw new Error('Need at least two exposures.');
    const started = Date.now();
    let shifts = null;
    if (opts.align) shifts = align();

    progress(40, opts.method === 'hdr' ? 'Merging (true HDR)…' : 'Fusing exposures…');
    const vec = vecOf();
    let f32;
    try {
      f32 = opts.method === 'hdr' && stack.every((s) => s.time > 0) ? trueHdr(vec, opts) : fuse(vec, opts);
    } finally {
      vec.delete();
    }

    progress(95, 'Encoding…');
    const { buf, w, h } = toRGBA(f32);
    f32.delete();
    post({ type: 'result', rgba: buf, w, h, shifts, ms: Date.now() - started, hasHdr: !!hdr }, [buf]);
  },

  // Radiance floats for .hdr export, fetched only when the user asks.
  hdr() {
    if (!hdr) throw new Error('No radiance map — merge with the true-HDR method first.');
    const buf = new Float32Array(hdr.data32F).buffer;
    post({ type: 'hdrData', data: buf, w: hdr.cols, h: hdr.rows }, [buf]);
  },

  reset() { free(); post({ type: 'reset' }); },
};

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (!cv) {
      progress(1, 'Loading engine…');
      cv = await self.cv;
      post({ type: 'ready', version: cv.getBuildInformation ? 'opencv.js' : 'opencv.js' });
    }
    ops[msg.type](msg);
  } catch (err) {
    const message = describe(err);
    // A wasm heap that has hit its ceiling stays broken — verified: retrying in
    // the same instance OOMs again. The page throws this worker away and restarts.
    post({ type: 'error', message, oom: isOOM(message) });
  }
};

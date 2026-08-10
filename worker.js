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

// Rotation is estimated on a copy no wider than this. It is a single global
// angle, so the extra precision from full resolution is not worth the time.
const ECC_WIDTH = 1120;
// Below this the correction is not worth resampling the frame for: an integer
// shift copies pixels exactly, warpAffine interpolates and softens slightly.
const MIN_ANGLE_DEG = 0.02;

// Grayscale, downscaled, float — what findTransformECC wants.
function eccInput(gray, k) {
  const small = new cv.Mat();
  if (k < 1) cv.resize(gray, small, new cv.Size(0, 0), k, k, cv.INTER_AREA);
  else gray.copyTo(small);
  const f = new cv.Mat();
  small.convertTo(f, cv.CV_32F, 1 / 255);
  small.delete();
  return f;
}

// AlignMTB's process(src, dst, ...) never writes to the dst MatVector through
// the JS bindings, so drive the shift search directly. Reference is the middle
// frame, which is the closest to a normal exposure.
//
// MTB only models integer translation. Handheld frames also rotate — measured
// 0.04-0.53 deg on a real bracket, which left 1.7-10.6 px of residual error
// that no shift can remove. findTransformECC refines each frame to a Euclidean
// (rotation + translation) fit, seeded by the MTB shift; that cut the residual
// to 1.0-3.0 px on the same frames. ECC maximises the correlation coefficient,
// which is already invariant to brightness and contrast, so the wide exposure
// spread needs no normalising and no edge extraction.
function align() {
  const ref = stack[Math.floor(stack.length / 2)];
  const mtb = new cv.AlignMTB(6, 4, true);
  const grayRef = new cv.Mat();
  cv.cvtColor(ref.mat, grayRef, cv.COLOR_RGB2GRAY);
  const k = Math.min(1, ECC_WIDTH / grayRef.cols);
  const refSmall = eccInput(grayRef, k);
  const crit = new cv.TermCriteria(cv.TermCriteria_EPS | cv.TermCriteria_COUNT, 80, 1e-6);
  const noMask = new cv.Mat();
  const size = new cv.Size(grayRef.cols, grayRef.rows);
  const shifts = [];

  for (let i = 0; i < stack.length; i++) {
    if (stack[i] === ref) { shifts.push({ x: 0, y: 0, deg: 0 }); continue; }
    progress(10 + (25 * i) / stack.length, `Aligning frame ${i + 1}…`);
    const gray = new cv.Mat();
    cv.cvtColor(stack[i].mat, gray, cv.COLOR_RGB2GRAY);
    const s = mtb.calculateShift(grayRef, gray);

    let deg = 0, warp = null;
    const movSmall = eccInput(gray, k);
    try {
      warp = cv.Mat.eye(2, 3, cv.CV_32F);
      warp.data32F[2] = -s.x * k;   // seed with the shift MTB already found
      warp.data32F[5] = -s.y * k;
      cv.findTransformECC(refSmall, movSmall, warp, cv.MOTION_EUCLIDEAN, crit, noMask, 5);
      deg = -Math.atan2(warp.data32F[3], warp.data32F[0]) * 180 / Math.PI;
      warp.data32F[2] /= k;         // rotation is scale-free, translation is not
      warp.data32F[5] /= k;
    } catch (err) {
      // ECC throws when it cannot converge — a near-black frame usually.
      if (warp) { warp.delete(); warp = null; }
      deg = 0;
    }
    movSmall.delete();
    gray.delete();

    const out = new cv.Mat();
    if (warp && Math.abs(deg) >= MIN_ANGLE_DEG) {
      cv.warpAffine(stack[i].mat, out, warp, size,
                    cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE, new cv.Scalar());
    } else {
      mtb.shiftMat(stack[i].mat, out, s);   // exact pixel copy, no resampling
      deg = 0;
    }
    if (warp) warp.delete();
    stack[i].mat.delete();
    stack[i].mat = out;
    shifts.push({ x: s.x, y: s.y, deg });
  }

  noMask.delete();
  refSmall.delete();
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

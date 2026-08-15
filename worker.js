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

// The reference frame anchors both alignment and deghosting, so pick the one
// carrying the most usable detail: well-exposed pixels minus blown ones. Blown
// highlights are penalised because saturation is unrecoverable and breaks the
// intensity mapping deghosting depends on. On a real bracket this chose the
// 1/125 frame over the brighter 1/30 one, whose sky was 22.6% blown.
function pickReference() {
  let best = 0, bestScore = -Infinity;
  for (let i = 0; i < stack.length; i++) {
    const gray = new cv.Mat();
    cv.cvtColor(stack[i].mat, gray, cv.COLOR_RGB2GRAY);
    const d = gray.data;
    let good = 0, blown = 0;
    for (let p = 0; p < d.length; p += 7) {   // every 7th pixel is plenty for a fraction
      const v = d[p];
      if (v > 16 && v < 240) good++;
      if (v >= 250) blown++;
    }
    gray.delete();
    const score = (good - blown) / Math.ceil(d.length / 7);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

// AlignMTB's process(src, dst, ...) never writes to the dst MatVector through
// the JS bindings, so drive the shift search directly.
//
// MTB only models integer translation. Handheld frames also rotate — measured
// 0.04-0.53 deg on a real bracket, which left 1.7-10.6 px of residual error
// that no shift can remove. findTransformECC refines each frame to a Euclidean
// (rotation + translation) fit, seeded by the MTB shift; that cut the residual
// to 1.0-3.0 px on the same frames. ECC maximises the correlation coefficient,
// which is already invariant to brightness and contrast, so the wide exposure
// spread needs no normalising and no edge extraction.
function align(refIdx) {
  const ref = stack[refIdx];
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

// --- deghosting -----------------------------------------------------------
// OpenCV has no deghosting merge, so fix the stack before MergeMertens sees it.
// Two frames of the same scene at different exposures are related by a
// monotonic intensity mapping, so matching histogram quantiles recovers it.
// Predict each frame from the reference through that mapping; wherever the real
// frame disagrees, something moved, and the prediction is substituted. All
// frames then agree on the moving subject and it fuses as a single solid copy.

// Quantile-matching LUT taking reference levels to this frame's levels.
//
// The histogram is sampled by striding over pixels, never by resizing down:
// INTER_AREA averages neighbours and invents intermediate values that do not
// exist in the image, which skews the distribution and hence the mapping. That
// alone made a completely static scene report 3.1% of the frame as ghosted.
function toneLUT(refCh, movCh) {
  const a = refCh.data, b = movCh.data;
  const stride = Math.max(1, Math.floor(a.length / 1e6));
  const hr = new Uint32Array(256), hm = new Uint32Array(256);
  let n = 0;
  for (let p = 0; p < a.length; p += stride) { hr[a[p]]++; hm[b[p]]++; n++; }
  const lut = new cv.Mat(1, 256, cv.CV_8UC1);
  if (!n) { for (let v = 0; v < 256; v++) lut.data[v] = v; return lut; }
  let cr = 0, cm = hm[0], w = 0;
  for (let v = 0; v < 256; v++) {
    cr += hr[v];
    while (w < 255 && cm < cr) { w++; cm += hm[w]; }
    lut.data[v] = w;
  }
  return lut;
}

// Reference predicted into the exposure of frame `mov`.
function predictFrom(ref, mov) {
  const rc = new cv.MatVector(), mc = new cv.MatVector();
  cv.split(ref, rc); cv.split(mov, mc);
  const outv = new cv.MatVector();
  for (let c = 0; c < 3; c++) {
    const lut = toneLUT(rc.get(c), mc.get(c));
    const mapped = new cv.Mat();
    cv.LUT(rc.get(c), lut, mapped);
    outv.push_back(mapped);
    lut.delete(); mapped.delete();
  }
  const pred = new cv.Mat();
  cv.merge(outv, pred);
  rc.delete(); mc.delete(); outv.delete();
  return pred;
}

// Returns the fraction of the frame replaced.
function deghostFrame(frame, pred, refGray, k) {
  const diff = new cv.Mat();
  cv.absdiff(frame, pred, diff);
  const ch = new cv.MatVector();
  cv.split(diff, ch);
  const d = new cv.Mat();
  cv.max(ch.get(0), ch.get(1), d);
  cv.max(d, ch.get(2), d);
  ch.delete(); diff.delete();
  cv.GaussianBlur(d, d, new cv.Size(0, 0), 2);

  // Threshold from the frame's own noise: median + k*MAD over pixels where the
  // reference actually carries detail.
  // Only where the reference itself carries detail. Where it is blown or black
  // the predicted value is meaningless, and the other frames legitimately hold
  // different content there — that is the highlight and shadow recovery the
  // whole bracket exists for. Substituting there would throw it away.
  const dd = d.data, rg = refGray.data;
  const sample = [];
  const usable = (p) => rg[p] > 4 && rg[p] < 250;
  for (let p = 0; p < dd.length; p += 11) if (usable(p)) sample.push(dd[p]);
  if (sample.length < 500) { d.delete(); return 0; }
  sample.sort((x, y) => x - y);
  const med = sample[sample.length >> 1];
  const dev = sample.map((v) => Math.abs(v - med)).sort((x, y) => x - y);
  const mad = dev[dev.length >> 1] * 1.4826;
  const thr = Math.max(10, med + k * mad);
  const span = Math.max(thr * 0.6, 6);

  const alpha = new cv.Mat(d.rows, d.cols, cv.CV_8UC1);
  const ad = alpha.data;
  for (let p = 0; p < dd.length; p++) {
    ad[p] = usable(p) ? Math.max(0, Math.min(255, ((dd[p] - thr) / span) * 255)) : 0;
  }
  d.delete();
  // Erode before dilating. Real movement is a connected blob and survives;
  // isolated speckle from noise and from a global tone curve not fitting every
  // local colour does not. Without this a static scene still flagged 6% of the
  // frame, because dilation alone amplifies exactly that speckle.
  const small = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
  const big = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(11, 11));
  cv.erode(alpha, alpha, small);
  cv.dilate(alpha, alpha, big);
  small.delete(); big.delete();
  cv.GaussianBlur(alpha, alpha, new cv.Size(0, 0), 9);

  // Blend in place over the raw bytes — cheaper in memory than float Mats.
  const fd = frame.data, pd = pred.data, av = alpha.data;
  let covered = 0;
  for (let p = 0, q = 0; p < fd.length; p += 3, q++) {
    const a = av[q];
    if (a === 0) continue;
    covered += a;
    const inv = 255 - a;
    fd[p] = (fd[p] * inv + pd[p] * a) / 255;
    fd[p + 1] = (fd[p + 1] * inv + pd[p + 1] * a) / 255;
    fd[p + 2] = (fd[p + 2] * inv + pd[p + 2] * a) / 255;
  }
  const frac = covered / (255 * av.length);
  alpha.delete();
  return frac;
}

function deghost(refIdx, k) {
  const ref = stack[refIdx].mat;
  const refGray = new cv.Mat();
  cv.cvtColor(ref, refGray, cv.COLOR_RGB2GRAY);
  let total = 0;
  for (let i = 0; i < stack.length; i++) {
    if (i === refIdx) continue;
    progress(36 + (6 * i) / stack.length, `Removing ghosts ${i + 1}…`);
    const pred = predictFrom(ref, stack[i].mat);
    total += deghostFrame(stack[i].mat, pred, refGray, k);
    pred.delete();
  }
  refGray.delete();
  return (100 * total) / Math.max(1, stack.length - 1);
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
  const out = new cv.Mat();
  const t = { drago: () => new cv.TonemapDrago(opts.gamma, opts.saturation, opts.bias),
              mantiuk: () => new cv.TonemapMantiuk(opts.gamma, opts.scale, opts.saturation),
              reinhard: () => new cv.TonemapReinhard(opts.gamma, opts.intensity, opts.lightAdapt, opts.colorAdapt) }
            [opts.tonemap];
  if (t) {
    const op = t();
    op.process(hdr, out);
    op.delete();
    return out;
  }
  // "Linear (gamma only)" used to fall through to `new cv.Tonemap(gamma)`. That
  // is OpenCV's abstract base class: this build exposes the symbol but it has
  // no accessible constructor, so choosing Linear in the UI threw "Tonemap has
  // no accessible constructor" and the merge failed outright. The three named
  // subclasses were fine, which is why it went unnoticed.
  //
  // Doing it by hand is what the base class does anyway: normalise the radiance
  // map to 0..1, then apply gamma.
  linearTonemap(hdr, out, opts.gamma);
  return out;
}

// Normalise to 0..1 across all channels together, then gamma. Per-channel
// normalisation would shift the white balance of the result.
//
// The range has to come from split channels: minMaxLoc rejects multi-channel
// input, and this build has no Mat.reshape to flatten around it.
function linearTonemap(src, dst, gamma) {
  const g = gamma > 0 ? gamma : 1;
  const ch = new cv.MatVector();
  cv.split(src, ch);
  let lo = Infinity, hi = -Infinity;
  for (let c = 0; c < ch.size(); c++) {
    const mm = cv.minMaxLoc(ch.get(c));
    lo = Math.min(lo, mm.minVal);
    hi = Math.max(hi, mm.maxVal);
  }
  for (let c = 0; c < ch.size(); c++) ch.get(c).delete();
  ch.delete();
  const span = hi - lo;
  const tmp = new cv.Mat();
  if (span > 1e-12) src.convertTo(tmp, cv.CV_32F, 1 / span, -lo / span);
  else src.convertTo(tmp, cv.CV_32F, 0, 0);
  cv.pow(tmp, 1 / g, dst);
  tmp.delete();
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
    const refIdx = pickReference();
    let shifts = null;
    if (opts.align) shifts = align(refIdx);
    const ghosted = opts.deghost ? deghost(refIdx, opts.ghostK ?? 3) : null;

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
    // refIdx lets the page draw the "before" image itself, from the bitmap it
    // already holds — the reference is the one frame alignment never warps, so
    // it lines up with the result pixel for pixel without shipping it back.
    post({ type: 'result', rgba: buf, w, h, shifts, ghosted, refIdx,
           ms: Date.now() - started, hasHdr: !!hdr }, [buf]);
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

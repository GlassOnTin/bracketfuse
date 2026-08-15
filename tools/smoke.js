#!/usr/bin/env node
// Headless smoke test. Runs the real worker.js under a node worker shim, over
// synthetic exposures, and exercises every merge method and tone-map option.
//
// It exists because "Linear (gamma only)" crashed every time it was selected --
// `new cv.Tonemap(gamma)` is the abstract base class, present in this build but
// with no accessible constructor. The three named subclasses worked, so nothing
// caught it. A path that is only reachable through one dropdown value needs
// something that walks the dropdown.
//
// It also installs a guard that reports any read of `.data` from a Mat whose
// rows are not contiguous. OpenCV.js's `.data` accessor ignores stride, so on a
// submatrix it silently returns the wrong bytes -- a bug that cost SolFuse a
// whole invalidated measurement.
//
//   node tools/smoke.js

const fs = require('fs');
const vm = require('vm');
const guard = require('./strided-guard.js');

const REPO = require('path').join(__dirname, '..');
let hits = null;
const posted = [];

const sandbox = {
  console,
  Date, Math, JSON, Error, Promise, Uint8Array, Uint8ClampedArray, Uint32Array,
  Float32Array, Int32Array, Array, Object, String, Number, Boolean, isNaN, parseInt, parseFloat,
  setTimeout, clearTimeout,
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.importScripts = (p) => {
  const mod = require(`${REPO}/${p}`);
  sandbox.cv = mod;                       // the export is a thenable
  Promise.resolve(mod).then((cv) => { hits = guard(cv); });
};
sandbox.postMessage = (m) => posted.push(m);

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(`${REPO}/worker.js`, 'utf8'), sandbox, { filename: 'worker.js' });

// Three synthetic exposures of one scene: a textured gradient with a moving
// blob, so alignment, deghosting and the tone LUT all have something to do.
const W = 320, H = 240;
function exposure(gain, dx, dy) {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let v = 40 + 120 * (x / W) + 60 * Math.sin(x / 9) * Math.cos(y / 11);
      const d = Math.hypot(x - (160 + dx), y - (120 + dy));
      if (d < 25) v += 90;                        // the "moving" object
      v *= gain;
      a[i] = Math.max(0, Math.min(255, v));
      a[i + 1] = Math.max(0, Math.min(255, v * 0.95));
      a[i + 2] = Math.max(0, Math.min(255, v * 0.9));
      a[i + 3] = 255;
    }
  }
  return a;
}

(async () => {
  const send = async (m) => { await sandbox.onmessage({ data: m }); };
  await send({ type: 'push', rgba: exposure(0.5, 0, 0).buffer, w: W, h: H, time: 1 / 125 });
  await send({ type: 'push', rgba: exposure(1.0, 2, -1).buffer, w: W, h: H, time: 1 / 30 });
  await send({ type: 'push', rgba: exposure(1.8, -1, 2).buffer, w: W, h: H, time: 1 / 8 });
  await send({ type: 'run', opts: { align: true, deghost: true, ghostK: 3, method: 'fuse' } });
  for (const tm of ['drago', 'reinhard', 'mantiuk', 'linear']) {
    const before = posted.length;
    await send({ type: 'run', opts: { align: true, deghost: true, ghostK: 3, method: 'hdr',
                                      tonemap: tm, gamma: 1.6, saturation: 0.9, bias: 0.85,
                                      intensity: 0, lightAdapt: 0.8, colorAdapt: 0, scale: 0.7 } });
    const got = posted.slice(before);
    const err = got.find((p) => p.type === 'error');
    const res = got.find((p) => p.type === 'result');
    let stats = '';
    if (res) {
      const a2 = new Uint8ClampedArray(res.rgba);
      let lo = 255, hi = 0, sum = 0, n = 0, black = 0, blown = 0;
      for (let i = 0; i < a2.length; i += 4) {
        const v = (a2[i] + a2[i + 1] + a2[i + 2]) / 3;
        lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v; n++;
        if (v < 2) black++; if (v > 253) blown++;
      }
      stats = `min ${lo.toFixed(0)} mean ${(sum / n).toFixed(1)} max ${hi.toFixed(0)}  ` +
              `black ${(100 * black / n).toFixed(1)}% blown ${(100 * blown / n).toFixed(1)}%`;
    }
    console.log(`  tonemap ${tm.padEnd(9)} ${err ? 'FAILED: ' + err.message : 'ok  ' + stats}`);
  }

  const errs = posted.filter((p) => p.type === 'error');
  const results = posted.filter((p) => p.type === 'result');
  console.log(`\nbracketfuse: ${results.length} merges completed, ${errs.length} errors`);
  for (const e of errs) console.log('  error:', e.message);
  console.log('\n=== strided .data reads detected during the run ===');
  if (!hits || hits.size === 0) console.log('  none');
  else for (const [k, n] of hits) console.log(`  ${n}x  ${k}`);
})();

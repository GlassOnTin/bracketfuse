# BracketFuse

Merge exposure brackets into one image, entirely in your browser. Drop in 2–9
bracketed photos, get back an aligned, merged, tone-mapped result. No install,
no account, no backend — the pixels never leave the device.

A static site: fork it, enable GitHub Pages, done.

## What it does

- **Decode** — `createImageBitmap`, EXIF exposure time / ISO / aperture via [exifr](https://github.com/MikeKovarik/exifr)
- **Align** — `cv.AlignMTB` median-threshold bitmaps, for handheld stacks
- **Exposure fusion** (default) — `cv.MergeMertens`. No exposure times needed, display-ready output
- **True HDR** — `cv.CalibrateDebevec` + `cv.MergeDebevec` into a real radiance map, then Drago / Reinhard / Mantiuk tone mapping
- **Export** — JPEG, PNG, and Radiance `.hdr` from the true-HDR path

Everything OpenCV runs in a Web Worker, so the page stays responsive.

## Measured behaviour

Numbers from desktop Chrome on Linux (Ryzen workstation), using the synthetic
13-stop bracket that `tools/make-testdata.py` generates. Regenerate the fixtures
and you can re-run all of these.

| Test | Result |
|---|---|
| 5 × 1.9 MP exposure fusion | 0.7 s |
| 5 × 1.9 MP true HDR + Drago | 2.4 s |
| 5 × 12 MP input, Auto size | 3.0 s end-to-end, output 6 MP |
| Alignment on known jitter (±11 px, frames 4 EV apart) | 5/5 recovered to the exact pixel |
| Radiance map vs ground truth | one global scale factor, 27.4 ± 1.2 across a 3482:1 range |
| `.hdr` round-trip through OpenCV's reader | 0.39 % worst error over 1e-30 … 1e6 (RGBE's 8-bit mantissa floor) |

Fusion output was checked against desktop OpenCV 4.10 (`cv2.createMergeMertens`)
on the same inputs: 15.1 % vs 14.77 % of pixels at full white, both overshooting
to ~1.12 before clamping. The WASM path matches the reference implementation.

### Memory is the binding constraint

The wasm heap, not CPU time, is what limits stack size. Measured pass/fail for
`MergeMertens` in desktop Chrome:

| Stack | Result |
|---|---|
| 3 × 10 MP | ok |
| 5 × 6 MP | ok (2.2 s) |
| 5 × 8 MP | **out of memory** |
| 9 × 4 MP | ok (2.7 s) |

So **5 × 12 MP at full resolution does not work** with this engine. "Auto" sizing
targets 30 MP total across the stack, capped at 8 MP per frame, which lands
inside the envelope above.

Two consequences worth knowing:

- Once the heap is exhausted it stays exhausted — retrying inside the same worker
  OOMs again (verified). On OOM the app **throws the worker away**, spawns a fresh
  one, and retries at 60 % of the resolution, saying so in the status line.
- Choosing "Full" on a large stack costs two failed attempts (~8 s) before it
  settles on a size that fits.

### Exposure fusion blows large flat highlights

`MergeMertens` weights each pixel by contrast × saturation × well-exposedness. In
a large, flat, bright region all three collapse toward zero, the weight map
degenerates, and pyramid reconstruction overshoots past 1.0. On the test scene
the window comes out pure white even though the shortest exposure captured it
with nothing clipped.

This is upstream OpenCV behaviour, reproduced identically on desktop. If it
matters for your image, use **True HDR + tone map** — on the same scene that path
returns 0 % blown and 0 % crushed pixels, with the window's colour intact.

## Measure your own device

[`selftest.html`](https://glassontin.github.io/bracketfuse/selftest.html) runs the
ladder above on whatever device opens it and prints a table you can paste into an
issue. Each trial gets a fresh worker, results are written to `localStorage` as
they finish so a crashed tab still leaves a record, and the `n=5` ladder stops as
soon as it hits the ceiling. Device reports are welcome — mobile numbers are the
gap in the table above.

## Not tested

- **Any mobile browser.** Desktop Chrome only. Phones have less wasm headroom, so
  Auto sizing will likely need to be more conservative there; the OOM retry path
  is what catches it. Run the self-test above if you want the number for yours.
- Firefox and Safari.
- Real camera files — all testing used synthetic brackets with known ground truth.
- Moving subjects. There is no deghosting; anything that moves between frames
  will ghost. See below.

### Moving subjects ghost, and the bracket's time span is what decides it

Tested on a real handheld bracket: a Sony RX10 IV 5-shot bracket (1/8000 → 1/30,
f/16, ISO 400) of a crowded terrace, 20 MP frames, merged at 3.33 MP.

Alignment held up. `AlignMTB` corrected 57 px of horizontal and 50 px of vertical
handheld drift across the stack, and the static stonework came out sharp at 1:1
with no visible doubling. Feature fitting still showed 0.2–0.8° of residual
rotation between frames, which `AlignMTB` cannot model at all — but at this
resolution it did not visibly hurt.

The people did not survive. Merging 9 frames spanning 16 s produced stacked
translucent copies of every person, with white halos where someone stood against
sky in only some frames. Cutting to 3 frames spanning 3 s left most people solid.
Frame count and elapsed time drive this, not alignment quality — so the app now
reads `DateTimeOriginal` and warns when a selection spans more than 3 s, or when
exposure times repeat (which means more than one bracket got selected).

One more thing that showed up: at 1/8000 f/16 ISO 400 the darkest frame has a
median pixel value of **1**, with 85 % of pixels within ±8 of that median.
`AlignMTB` thresholds at the median, so its bitmap is essentially noise and the
shift it computes for such a frame is not trustworthy — ORB independently found
2 usable inliers on those frames versus 350–845 on the mid-exposure ones. Very
dark frames contribute little to the fusion anyway, but their alignment should
not be believed.

## Not implemented

RAW decoding, deghosting, batch processing, Ultra HDR / gain-map JPEG export,
PWA offline install, before/after slider. None of these may introduce a backend.

## Running it

Any static file server, because workers and modules need real HTTP:

```sh
python3 -m http.server 8777
```

Then open <http://127.0.0.1:8777/>.

To deploy: enable GitHub Pages on the repository, serving from the branch root.
There is no build step.

## Repository layout

```
index.html            markup + styles
app.js                main thread: decode, EXIF, UI, worker orchestration, export
worker.js             all OpenCV work
rgbe.js               Radiance .hdr encoder (separate so it is testable in node)
vendor/opencv.js      pinned OpenCV 5.0.0 WASM build, photo module included
vendor/exifr.js       pinned exifr lite build
tools/fetch-engine.sh re-download vendor/ and verify against pinned sha256sums
tools/make-testdata.py regenerate the synthetic bracket fixtures
testdata/             the committed 1600×1200 bracket
```

### On the OpenCV build

The stock `opencv.js` from docs.opencv.org omits the `photo` module — no
`AlignMTB`, no `MergeMertens`, no tone mappers. Rather than maintain a custom
Emscripten build, this project vendors
[`@techstark/opencv-js`](https://github.com/TechStark/opencv-js), which already
ships them. It is a single ~13 MB file (3.7 MB gzipped, 2.5 MB brotli) with the
WASM embedded, so there is no sidecar to serve. `tools/fetch-engine.sh` pins it
by sha256 so the vendored copy is verifiable against upstream.

Two quirks of that build the code works around:

- `AlignMTB.process(src, dst, …)` never writes to the destination `MatVector`
  through the JS bindings. `worker.js` drives `calculateShift` / `shiftMat`
  directly instead — which also needs single-channel input or it throws.
- `MergeMertens.process` is the 4-argument base-class signature; the 2-argument
  overload is bound as `process1`.

## Licence

MIT — see [LICENSE](LICENSE).

OpenCV is Apache-2.0, exifr is MIT. Both are redistributed unmodified in
`vendor/`.

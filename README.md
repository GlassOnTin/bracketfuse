# BracketFuse

Merge exposure brackets into one image, entirely in your browser. Drop in 2–9
bracketed photos, get back an aligned, merged, tone-mapped result. No install,
no account, no backend — the pixels never leave the device.

A static site: fork it, enable GitHub Pages, done.

## What it does

- **Decode** — `createImageBitmap`, EXIF exposure time / ISO / aperture via [exifr](https://github.com/MikeKovarik/exifr)
- **Align** — `cv.AlignMTB` median-threshold bitmaps for the integer shift, then
  `cv.findTransformECC` (`MOTION_EUCLIDEAN`) to recover rotation as well
- **Exposure fusion** (default) — `cv.MergeMertens`. No exposure times needed, display-ready output
- **True HDR** — `cv.CalibrateDebevec` + `cv.MergeDebevec` into a real radiance map, then Drago / Reinhard / Mantiuk tone mapping
- **Deghost** — moving subjects replaced with an exposure-matched prediction from
  the reference frame, so a walking crowd fuses as one solid copy
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

## Diagnosing failures without DevTools

Every failure path reports to the status line on the page, so a phone user can
say what went wrong without attaching a debugger. When anything is caught, a
**Copy error details** button appears with the user agent, core count, device
memory, screen size and the last 25 log lines, ready to paste into an issue.

Covered: worker exceptions (including OpenCV's raw wasm pointer throws, decoded
via `exceptionFromPtr`), worker crashes and message-clone failures, out-of-memory
with its automatic retry, per-file decode failures, frame preparation running out
of memory, `toBlob` returning null on a canvas too large to encode, uncaught
exceptions and unhandled promise rejections anywhere on the page, and any asset
that fails to load.

The handler is a classic inline script at the top of the document, before the
module. That is deliberate: the one failure a phone user cannot diagnose is the
module graph not loading, because the page renders normally and simply does
nothing when you drop photos on it. That case was silent before — now the missing
file is named immediately, and a watchdog reports it if the app has not started
within 8 seconds.

Verified by fault injection: unhandled rejection, throw in a timer, throw in an
event handler, a 404'd script, and a genuinely missing module all reach the
status line. A clean merge logs nothing and leaves the button hidden.

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
with no visible doubling. It did leave 0.04–0.53° of rotation, which `AlignMTB`
cannot model at all — see below.

The people did not survive. Merging 9 frames spanning 16 s produced stacked
translucent copies of every person, with white halos where someone stood against
sky in only some frames. Cutting to 3 frames spanning 3 s left most people solid.
Frame count and elapsed time drive this, not alignment quality — so the app now
reads `DateTimeOriginal` and warns when a selection spans more than 3 s, or when
exposure times repeat (which means more than one bracket got selected).

### Deghosting

OpenCV has no deghosting merge, so the stack is repaired before `MergeMertens`
sees it. Two frames of one scene at different exposures are related by a
monotonic intensity mapping, so matching histogram quantiles recovers it without
needing exposure times or a camera response. Each frame is predicted from the
reference through that mapping; where the real frame disagrees by more than
`median + 3·MAD` of its own residual, something moved, and the prediction is
substituted through a feathered mask. Every frame then agrees on the subject and
it fuses as one solid copy.

Two rules keep it from doing harm:

- **Never substitute where the reference is blown or black.** The prediction is
  meaningless there, and the other frames legitimately hold different content —
  that content *is* the highlight and shadow recovery the bracket exists for.
  Without this guard the darkest frame's genuine window detail was overwritten
  with white.
- **Sample the histogram by striding, never by resizing down.** `INTER_AREA`
  averages neighbours into values that do not occur in the image, skewing the
  distribution and therefore the mapping. That alone made a completely static
  scene report 3.1% of the frame as ghosted.

Measured on a synthetic scene where the ideal deghosted answer is known (a
subject moved 520 px across the stack, compared against the same stack with it
frozen at the reference position):

| | error in the swept region | error on static content |
|---|---|---|
| no deghosting | 21.29 | 0.74 |
| deghosted | **6.02** | **0.35** |

(mean absolute difference from the ideal merge, 0–255 scale — static content got
slightly *better*, so it is not damaging clean areas.)

On the real crowd bracket it replaces 4.6% of the frame and most people come out
solid instead of translucent; a few silhouetted against bright sky survive,
because the reference is blown there and the guard above correctly declines to
touch it. On a static tripod stack it replaces 0.0% and the output is identical
to not running it at all.

The hardest real case — 9 frames spanning 16 s across two brackets, the selection
that produced the original ghosted result — at 2236×1491, scored against the
app's own reference frame with alignment geometry held identical between runs:

| region | deghost off | deghost on |
|---|---|---|
| crowd band | 0.8729 | **0.9696** |
| static stonework | 0.9208 | 0.9291 |

6.6% of the frame replaced; merge time 4.9 s → 10.3 s. The gain is concentrated
exactly where subjects move, and static content is unchanged.

A caution about that table: it is only meaningful because both runs share the
same alignment. Comparing across builds that aligned to *different* reference
frames is invalid — a rotated result cannot be matched by a shift search, and
the score drops for reasons that have nothing to do with ghosting. Three earlier
attempts at a real-image metric failed exactly that way before this one.

Reference choice matters more than the threshold. The frame is picked by
*well-exposed fraction minus blown fraction*; on the real bracket that chose the
1/125 frame over the brighter 1/30 one, whose sky was 22.6% blown. That single
choice moved the crowd-band score from 0.9216 to 0.9873.

### Rotation: why ECC, and why no normalisation

`AlignMTB` is integer translation only. Candidates for recovering rotation were
benchmarked against known ground truth (a real photo re-projected by known
angles, then exposed across 8 stops down to a median pixel value of 1, matching
the real bracket). Only primitives the WASM build actually exposes were allowed —
`phaseCorrelate` and `logPolar` are absent, so phase correlation was hand-rolled
from `dft`.

| method | mean absolute angle error | time |
|---|---|---|
| `AlignMTB` (translation only) | 0.637° — cannot model rotation | 0.1 s |
| ECC on raw greyscale | **0.001°** | 1.7 s |
| ECC on normalised gradient | 0.002° | 3.8 s |
| ECC on MTB bitmaps | 0.005° | 2.1 s |
| ORB + affine RANSAC | 0.014° | 0.5 s |
| Fourier–Mellin (log-polar) | 0.094° | 2.3 s |

Normalising the images or switching to edges does not help, and costs up to 2×
the time. `findTransformECC` maximises the enhanced correlation coefficient,
which is **already invariant to affine photometric change** — brightness and
contrast — so the exposure spread is handled by the cost function itself. That
invariance is the whole point of ECC over plain SSD.

Fourier–Mellin works and is a reasonable idea, but it is 10–100× less accurate
here (its angular resolution is set by the log-polar bin count) and no faster.

On the real bracket, where there is no ground truth, ECC / ORB / Fourier–Mellin
independently agree to within ~0.03° on the well-exposed frames. Measuring
registration directly — median displacement of matched static features after
alignment — gives:

| frame | `AlignMTB` alone | + ECC rotation | recovered angle |
|---|---|---|---|
| DSC06648 (1/8000) | 8.01 px | 2.99 px | 0.044° |
| DSC06649 (1/2000) | 10.57 px | 2.99 px | 0.528° |
| DSC06651 (1/125) | 3.22 px | 1.44 px | 0.361° |
| DSC06652 (1/30) | 1.73 px | 1.00 px | 0.116° |

So ECC refinement roughly halves to thirds the residual on every frame, for about
0.2 s extra per stack. It is seeded with the MTB shift, estimated on a copy no
wider than 1120 px (a single global angle does not need full resolution), and
falls back to the plain integer shift when it fails to converge or finds less
than 0.02° — an integer shift copies pixels exactly, where `warpAffine` would
interpolate and soften slightly for no gain.

Two cautions on reading the table above: a Laplacian-variance "sharpness" score
is **not** a valid comparison here, because the rotated path resamples and the
integer-shift path does not, and the blur difference swamps the registration
difference. And at 3.33 MP the visible improvement is subtle; it grows with
output resolution, since the same angle spans proportionally more pixels.

### Very dark frames

At 1/8000 f/16 ISO 400 the darkest frame has a
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

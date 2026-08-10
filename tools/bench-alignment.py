#!/usr/bin/env python3
"""Ground-truth benchmark for rotation-capable alignment across a wide exposure
spread.

    python3 tools/bench-alignment.py [source-image.jpg]

Re-projects one photo by known angles, exposes it across 8 stops, and scores how
well each candidate recovers the angle. Needs opencv-python + numpy.

Pass a real photograph. The default is the synthetic fixture, which is
deliberately smooth — the feature-based and Fourier methods need texture and
score far worse on it than they do on real detail. ECC wins on either.
 Only uses primitives the opencv.js build actually exposes:
findTransformECC, warpPolar, dft, magnitude, ORB, BFMatcher, estimateAffine2D.
phaseCorrelate/logPolar are NOT available, so phase correlation is hand-rolled.
"""
import cv2, numpy as np

import sys, os
SRC = sys.argv[1] if len(sys.argv) > 1 else 'testdata/bracket_2.jpg'
GT_ANGLES = [0.0, 0.25, -0.40, 0.65, -0.85]        # degrees, handheld-scale
GT_SHIFTS = [(0, 0), (14, -9), (-21, 6), (8, 17), (-12, -20)]
STOPS     = [0.0, 2.0, 4.0, 6.0, 8.0]
HARSH     = True              # 8 stops total, like the real bracket
REF = 2

def make_frames():
    base = cv2.imread(SRC).astype(np.float32) / 255.0
    lin = np.where(base <= 0.04045, base / 12.92, ((base + 0.055) / 1.055) ** 2.4)
    H, W = lin.shape[:2]
    out = []
    for ang, (dx, dy), st in zip(GT_ANGLES, GT_SHIFTS, STOPS):
        M = cv2.getRotationMatrix2D((W / 2, H / 2), ang, 1.0)
        M[0, 2] += dx; M[1, 2] += dy
        g = cv2.warpAffine(lin, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        e = np.clip(g * (2.0 ** st) * (0.0035 if HARSH else 0.06), 0, 1)                       # exposure + clipping
        srgb = np.where(e <= 0.0031308, e * 12.92, 1.055 * e ** (1 / 2.4) - 0.055)
        n = np.random.default_rng(int(st)).normal(0, 0.004, e.shape)     # sensor noise
        out.append(np.clip((srgb + n) * 255, 0, 255).astype(np.uint8))
    return out

# ---------- exposure-invariant representations ------------------------------
def mtb_bitmap(gray):
    """Median-threshold bitmap: binary, invariant to any monotonic exposure change."""
    med = np.median(gray)
    return ((gray > med).astype(np.uint8) * 255)

def grad_norm(gray):
    """Locally contrast-normalised gradient magnitude."""
    g = cv2.GaussianBlur(gray.astype(np.float32), (0, 0), 1.2)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, 3); gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, 3)
    m = np.sqrt(gx * gx + gy * gy)
    m /= (cv2.GaussianBlur(m, (0, 0), 25) + 1e-3)
    return np.clip(m, 0, 4) / 4.0

# ---------- hand-rolled phase correlation (no cv2.phaseCorrelate) -----------
def _fft(a):
    return np.fft.rfft2(a)

def phase_corr(a, b):
    """Peak of the normalised cross-power spectrum -> (dx, dy), plus peak sharpness."""
    win = np.hanning(a.shape[0])[:, None] * np.hanning(a.shape[1])[None, :]
    A, B = _fft(a * win), _fft(b * win)
    R = A * np.conj(B)
    R /= (np.abs(R) + 1e-12)
    r = np.fft.irfft2(R, s=a.shape)
    iy, ix = np.unravel_index(np.argmax(r), r.shape)
    peak = r[iy, ix]
    if ix > a.shape[1] // 2: ix -= a.shape[1]
    if iy > a.shape[0] // 2: iy -= a.shape[0]
    return ix, iy, peak / (r.std() + 1e-12)

def _phase_corr_y_subpix(a, b):
    """Vertical shift only, with parabolic subpixel refinement of the peak."""
    win = np.hanning(a.shape[0])[:, None] * np.hanning(a.shape[1])[None, :]
    A, B = np.fft.rfft2(a * win), np.fft.rfft2(b * win)
    R = A * np.conj(B); R /= (np.abs(R) + 1e-12)
    r = np.fft.irfft2(R, s=a.shape)
    iy, ix = np.unravel_index(np.argmax(r), r.shape)
    n = r.shape[0]
    ym, y0, yp = r[(iy-1) % n, ix], r[iy, ix], r[(iy+1) % n, ix]
    denom = (ym - 2*y0 + yp)
    off = 0.5 * (ym - yp) / denom if abs(denom) > 1e-12 else 0.0
    y = iy + off
    if y > n / 2: y -= n
    return y, y0 / (r.std() + 1e-12)

def fourier_mellin(ref, mov):
    """Rotation from log-polar phase correlation of the DFT magnitudes."""
    def spectrum(x):
        win = np.hanning(x.shape[0])[:, None] * np.hanning(x.shape[1])[None, :]
        F = np.fft.fftshift(np.abs(np.fft.fft2(x * win)))
        return np.log1p(F)
    S1, S2 = spectrum(ref), spectrum(mov)
    h, w = S1.shape
    centre = (w / 2, h / 2)
    maxr = min(h, w) / 2
    flags = cv2.INTER_LINEAR | cv2.WARP_POLAR_LOG | cv2.WARP_FILL_OUTLIERS
    NB = 1440
    P1 = cv2.warpPolar(S1.astype(np.float32), (512, NB), centre, maxr, flags)
    P2 = cv2.warpPolar(S2.astype(np.float32), (512, NB), centre, maxr, flags)
    # rows of the polar image are angle; a rotation is a vertical shift
    dyf, conf = _phase_corr_y_subpix(P1, P2)
    ang = dyf * (360.0 / NB)
    # DFT magnitude is 180-degree symmetric -> resolve into (-90, 90]
    ang = ((ang + 90) % 180) - 90
    return ang, conf

# ---------- candidate aligners ----------------------------------------------
def m_mtb(ref_g, mov_g):
    mtb = cv2.createAlignMTB(6, 4, True)
    sx, sy = mtb.calculateShift(ref_g, mov_g)
    return 0.0, float(sx), float(sy)

def _ecc(ref_f, mov_f, init=None, levels=4):
    """Coarse-to-fine ECC, Euclidean (rotation + translation)."""
    warp = np.eye(2, 3, dtype=np.float32) if init is None else init.copy()
    pyr_r = [ref_f]; pyr_m = [mov_f]
    for _ in range(levels - 1):
        pyr_r.append(cv2.pyrDown(pyr_r[-1])); pyr_m.append(cv2.pyrDown(pyr_m[-1]))
    warp[0, 2] /= 2 ** (levels - 1); warp[1, 2] /= 2 ** (levels - 1)
    for lvl in range(levels - 1, -1, -1):
        crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 100, 1e-7)
        try:
            cv2.findTransformECC(pyr_r[lvl], pyr_m[lvl], warp, cv2.MOTION_EUCLIDEAN, crit, None, 5)
        except cv2.error:
            return None
        if lvl:
            warp[0, 2] *= 2; warp[1, 2] *= 2
    return warp

def _from_warp(w):
    if w is None: return None
    return -float(np.degrees(np.arctan2(w[1, 0], w[0, 0]))), -float(w[0, 2]), -float(w[1, 2])

def m_ecc_gray(ref_g, mov_g):
    return _from_warp(_ecc(ref_g.astype(np.float32) / 255, mov_g.astype(np.float32) / 255))

def m_ecc_mtb(ref_g, mov_g):
    a = cv2.GaussianBlur(mtb_bitmap(ref_g).astype(np.float32) / 255, (0, 0), 1.5)
    b = cv2.GaussianBlur(mtb_bitmap(mov_g).astype(np.float32) / 255, (0, 0), 1.5)
    return _from_warp(_ecc(a, b))

def m_ecc_grad(ref_g, mov_g):
    return _from_warp(_ecc(grad_norm(ref_g), grad_norm(mov_g)))

def m_ecc_mtb_seeded(ref_g, mov_g):
    """MTB integer shift as the seed, then ECC refines rotation on MTB bitmaps."""
    mtb = cv2.createAlignMTB(6, 4, True)
    sx, sy = mtb.calculateShift(ref_g, mov_g)
    init = np.eye(2, 3, dtype=np.float32); init[0, 2] = -sx; init[1, 2] = -sy
    a = cv2.GaussianBlur(mtb_bitmap(ref_g).astype(np.float32) / 255, (0, 0), 1.5)
    b = cv2.GaussianBlur(mtb_bitmap(mov_g).astype(np.float32) / 255, (0, 0), 1.5)
    return _from_warp(_ecc(a, b, init=init))

def m_fourier_mellin(ref_g, mov_g):
    a, b = grad_norm(ref_g), grad_norm(mov_g)
    ang, conf = fourier_mellin(a, b)
    return ang, float('nan'), float('nan')

def m_orb(ref_g, mov_g):
    orb = cv2.ORB_create(4000)
    ka, da = orb.detectAndCompute(cv2.equalizeHist(ref_g), None)
    kb, db = orb.detectAndCompute(cv2.equalizeHist(mov_g), None)
    if da is None or db is None or len(ka) < 30 or len(kb) < 30: return None
    m = sorted(cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(da, db), key=lambda x: x.distance)[:1500]
    if len(m) < 30: return None
    src = np.float32([ka[x.queryIdx].pt for x in m]).reshape(-1, 1, 2)
    dst = np.float32([kb[x.trainIdx].pt for x in m]).reshape(-1, 1, 2)
    M, inl = cv2.estimateAffine2D(dst, src, method=cv2.RANSAC, ransacReprojThreshold=2.0)
    if M is None or inl.sum() < 20: return None
    return float(np.degrees(np.arctan2(M[1, 0], M[0, 0]))), float(M[0, 2]), float(M[1, 2])

METHODS = [('AlignMTB (current)', m_mtb), ('ECC raw grey', m_ecc_gray),
           ('ECC on MTB bitmap', m_ecc_mtb), ('ECC on norm. gradient', m_ecc_grad),
           ('ECC MTB, MTB-seeded', m_ecc_mtb_seeded),
           ('Fourier-Mellin (log-polar)', m_fourier_mellin), ('ORB + affine RANSAC', m_orb)]

if __name__ == '__main__':
    frames = make_frames()
    grays = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in frames]
    print(f'source {SRC}  {grays[0].shape[1]}x{grays[0].shape[0]}, {len(frames)} frames, '
          f'{STOPS[-1]:.0f} stops apart\n')
    print('median brightness per frame:', [int(np.median(g)) for g in grays])
    print(f'\ntrue rotations vs reference: '
          f'{[round(a - GT_ANGLES[REF], 2) for a in GT_ANGLES]} deg\n')
    hdr = f"{'method':28s}" + ''.join(f'{"f"+str(i):>9}' for i in range(len(frames)) if i != REF) + f'{"mean|err|":>11}'
    print(hdr); print('-' * len(hdr))
    import time
    for name, fn in METHODS:
        errs, cells = [], []
        t0 = time.time()
        for i, g in enumerate(grays):
            if i == REF: continue
            r = fn(grays[REF], g)
            if r is None:
                cells.append(f'{"fail":>9}'); errs.append(float('nan')); continue
            ang = r[0]
            true = GT_ANGLES[i] - GT_ANGLES[REF]
            e = abs(ang - true)
            errs.append(e); cells.append(f'{ang:9.3f}')
        good = [e for e in errs if e == e]
        mean = np.mean(good) if good else float('nan')
        print(f'{name:28s}' + ''.join(cells) + f'{mean:11.3f}' + f'   ({time.time()-t0:.1f}s)')
    print(f'\ntrue values                 ' + ''.join(
        f'{GT_ANGLES[i]-GT_ANGLES[REF]:9.3f}' for i in range(len(frames)) if i != REF))

#!/usr/bin/env python3
"""Generate the synthetic bracket used to test BracketFuse.

A 13-stop interior scene (dark floor -> daylight through a window) rendered at
five shutter speeds, so the ground-truth radiance is known exactly. The darkest
frame clips nothing and the brightest crushes nothing, which means a correct
merge should recover the whole scene.

    python3 tools/make-testdata.py            # 1600x1200, the committed fixtures
    python3 tools/make-testdata.py --big      # 4000x3000, for testing memory limits

Needs numpy + pillow; exiftool if you want EXIF exposure times written.
"""
import argparse
import subprocess
import numpy as np
from PIL import Image

TIMES = [1 / 2000, 1 / 500, 1 / 125, 1 / 30, 1 / 8]
GAIN = 6.0


def radiance(w=1600, h=1200):
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    sx, sy = w / 1600, h / 1200
    wall = (0.35 + 0.25 * np.sin(x / (90 * sx)) * np.cos(y / (70 * sy)))[..., None]
    rad = wall * np.array([1.0, 0.92, 0.82], np.float32)

    win = (x > 980 * sx) & (x < 1500 * sx) & (y > 180 * sy) & (y < 820 * sy)
    rad[win] = np.array([120.0, 128.0, 150.0], np.float32)          # daylight
    frame = win & (((x / sx).astype(int) % 130 < 10) | ((y / sy).astype(int) % 210 < 10))
    rad[frame] = np.array([2.0, 1.9, 1.8], np.float32)              # window bars
    lamp = ((x - 300 * sx) ** 2 + (y - 300 * sy) ** 2) < (90 * sx) ** 2
    rad[lamp] = np.array([26.0, 22.0, 14.0], np.float32)
    rad[y > 900 * sy] *= 0.35                                       # floor

    rad += np.random.default_rng(7).normal(0, 0.004, rad.shape).astype(np.float32)
    return np.clip(rad, 1e-4, None).astype(np.float32)


def expose(rad, t):
    lin = np.clip(rad * t * GAIN, 0, 1)
    srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)
    return (srgb * 255 + 0.5).astype(np.uint8), lin


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--big', action='store_true', help='4000x3000 instead of 1600x1200')
    ap.add_argument('--out', default='testdata')
    args = ap.parse_args()

    w, h = (4000, 3000) if args.big else (1600, 1200)
    stem, quality = ('big', 50) if args.big else ('bracket', 94)
    rad = radiance(w, h)
    print(f'scene dynamic range {rad.max() / rad.min():.0f}:1 '
          f'({np.log2(rad.max() / rad.min()):.1f} stops) at {w}x{h}')

    for i, t in enumerate(TIMES):
        img, lin = expose(rad, t)
        path = f'{args.out}/{stem}_{i}.jpg'
        Image.fromarray(img).save(path, quality=quality)
        try:
            subprocess.run(['exiftool', '-q', '-overwrite_original', f'-ExposureTime={t}',
                            '-ISO=100', '-FNumber=8.0', path], check=True)
        except (FileNotFoundError, subprocess.CalledProcessError):
            pass  # EXIF is optional; without it the app sorts by brightness
        print(f'  {path}  1/{round(1/t):<5} blown {(lin >= 0.999).mean()*100:5.1f}%  '
              f'crushed {(lin <= 0.002).mean()*100:5.1f}%')

    np.save(f'{args.out}/ground_truth_radiance.npy', rad) if not args.big else None


if __name__ == '__main__':
    main()

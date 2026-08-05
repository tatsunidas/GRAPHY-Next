#!/usr/bin/env python3
# GRAPHY-Next Benchmark Phantom (GNBP-1)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
#
"""Render axial/coronal/sagittal previews of a generated phantom series to PNG.

Purely a human sanity check — nothing in the benchmark depends on it.
"""

from __future__ import annotations

import argparse
import glob
import os

import numpy as np
from PIL import Image
from pydicom import dcmread


def load_series(series_dir: str) -> tuple[np.ndarray, tuple[float, float], float]:
    paths = sorted(glob.glob(os.path.join(series_dir, "*.dcm")))
    if not paths:
        raise SystemExit(f"no DICOM files in {series_dir}")
    first = dcmread(paths[0])
    vol = np.stack([dcmread(p).pixel_array for p in paths]).astype(np.int32)
    vol = vol * int(first.RescaleSlope) + int(first.RescaleIntercept)
    return vol, tuple(float(v) for v in first.PixelSpacing), float(first.SliceThickness)


def window(img: np.ndarray, center: float, width: float) -> np.ndarray:
    lo, hi = center - width / 2.0, center + width / 2.0
    out = (np.clip(img, lo, hi) - lo) / max(hi - lo, 1e-6)
    return (out * 255).astype(np.uint8)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("series_dir")
    ap.add_argument("--out", required=True)
    ap.add_argument("--center", type=float, default=200.0)
    ap.add_argument("--width", type=float, default=2400.0)
    args = ap.parse_args()

    vol, spacing, thickness = load_series(args.series_dir)
    nz, ny, nx = vol.shape

    axial = window(vol[nz // 2], args.center, args.width)
    coronal = window(vol[:, ny // 2, :], args.center, args.width)
    sagittal = window(vol[:, :, nx // 2], args.center, args.width)

    # Scale the reformats so that one screen pixel is one millimetre-ish.
    zoom = thickness / spacing[1]
    def stretch(a: np.ndarray) -> np.ndarray:
        img = Image.fromarray(a)
        return np.asarray(img.resize((a.shape[1], int(a.shape[0] * zoom)), Image.NEAREST))

    coronal, sagittal = stretch(coronal), stretch(sagittal)

    h = max(axial.shape[0], coronal.shape[0], sagittal.shape[0])
    panels = []
    for a in (axial, coronal, sagittal):
        pad = np.zeros((h, a.shape[1]), dtype=np.uint8)
        pad[: a.shape[0]] = a
        panels.append(pad)
        panels.append(np.full((h, 4), 60, dtype=np.uint8))
    Image.fromarray(np.hstack(panels[:-1])).save(args.out)
    print(f"wrote {args.out}  (volume {nz}x{ny}x{nx}, HU range {vol.min()}..{vol.max()})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

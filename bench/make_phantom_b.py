#!/usr/bin/env python3
# GRAPHY-Next Benchmark Phantom (GNBP-1)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
#
"""
GNBP-1B — GRAPHY-Next Benchmark Phantom, performance series.

A noisy, high-contrast, abdomen-like CT volume produced at several slice counts
so that viewer performance can be measured as a function of volume size.

Why a second phantom instead of reusing GNBP-1A: the Shepp-Logan phantom is
smooth, noise-free and low-contrast. It compresses and renders unrealistically
well, so timings taken on it would flatter the viewer. GNBP-1B deliberately
carries reconstruction-like noise and sharp high-contrast structure, which is
what a real study costs to decode and render. Conversely GNBP-1A, not this one,
is the phantom with analytic ground truth: noise makes HU truth statistical
rather than exact. Each series is fit for one purpose only.

The vessel is a helix whose centreline is known in closed form, so centreline
extraction and curved-MPR straightening can be checked against it even though
the surrounding tissue is noisy.

Usage:
    python3 make_phantom_b.py --out ./phantom                 # 64/128/256/512
    python3 make_phantom_b.py --out ./phantom --slices 256
    python3 make_phantom_b.py --out ./phantom --compress j2k  # JPEG2000 variant
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

import numpy as np

from dicom_io import HU_MAX, HU_MIN, series_checksum, write_series

PHANTOM_ID = "GNBP-1B"
PHANTOM_VERSION = "1.0"

ROWS = COLUMNS = 512
PIXEL_SPACING = (0.78125, 0.78125)  # mm — matches the HCC-TACE-Seg anchor case
SLICE_THICKNESS = 5.0  # mm
DEFAULT_SLICE_COUNTS = (64, 128, 256, 512)
NOISE_SIGMA_HU = 20.0
NOISE_SEED = 20260730

HU_AIR = -1000
HU_FAT = -90
HU_SOFT_TISSUE = 45
HU_LIVER = 60
HU_VESSEL = 240  # contrast-enhanced
HU_BONE = 700
HU_LESION = (25, 90, 130)

# Helix parameters of the vessel, in millimetres. The centreline is
#   x(z) = HELIX_RX * cos(2 pi z / L),  y(z) = HELIX_RY * sin(2 pi z / L)
# with z measured from the first slice and L the stack length.
HELIX_RX_MM = COLUMNS * 0.13 * PIXEL_SPACING[0]
HELIX_RY_MM = ROWS * 0.07 * PIXEL_SPACING[1]
VESSEL_RADIUS_MM = COLUMNS * 0.020 * PIXEL_SPACING[0]


def build_volume(n_slices: int, seed: int = NOISE_SEED) -> np.ndarray:
    """(n_slices, ROWS, COLUMNS) int16 HU volume."""
    rng = np.random.default_rng(seed)

    yy, xx = np.mgrid[0:ROWS, 0:COLUMNS].astype(np.float32)
    cy, cx = (ROWS - 1) / 2.0, (COLUMNS - 1) / 2.0

    body_a, body_b = COLUMNS * 0.42, ROWS * 0.32
    body = ((xx - cx) / body_a) ** 2 + ((yy - cy) / body_b) ** 2 <= 1.0

    fat_a, fat_b = body_a * 0.90, body_b * 0.90
    inner = ((xx - cx) / fat_a) ** 2 + ((yy - cy) / fat_b) ** 2 <= 1.0
    fat_shell = body & ~inner

    spine = ((xx - cx) ** 2 + (yy - (cy + body_b * 0.62)) ** 2) <= (ROWS * 0.055) ** 2
    rib_r = np.sqrt(((xx - cx) / (body_a * 0.93)) ** 2 + ((yy - cy) / (body_b * 0.93)) ** 2)
    ribs = (rib_r > 0.93) & (rib_r < 0.97) & (yy < cy + body_b * 0.3)

    volume = np.empty((n_slices, ROWS, COLUMNS), dtype=np.float32)

    for k in range(n_slices):
        z = k / max(n_slices - 1, 1)

        sl = np.full((ROWS, COLUMNS), float(HU_AIR), dtype=np.float32)
        sl[body] = HU_SOFT_TISSUE
        sl[fat_shell] = HU_FAT

        organ_scale = np.sin(np.pi * np.clip(z * 1.15, 0.0, 1.0)) ** 0.5
        if organ_scale > 0.05:
            oa, ob = body_a * 0.46 * organ_scale, body_b * 0.55 * organ_scale
            ocx, ocy = cx - body_a * 0.30, cy - body_b * 0.05
            organ = ((xx - ocx) / max(oa, 1e-3)) ** 2 + ((yy - ocy) / max(ob, 1e-3)) ** 2 <= 1.0
            sl[organ & body] = HU_LIVER

        vx = cx + (HELIX_RX_MM / PIXEL_SPACING[0]) * np.cos(2.0 * np.pi * z)
        vy = cy + (HELIX_RY_MM / PIXEL_SPACING[1]) * np.sin(2.0 * np.pi * z)
        vessel = ((xx - vx) ** 2 + (yy - vy) ** 2) <= (VESSEL_RADIUS_MM / PIXEL_SPACING[0]) ** 2
        sl[vessel & body] = HU_VESSEL

        for i, hu in enumerate(HU_LESION):
            lz = 0.25 + 0.25 * i
            lr_px = 0.055 * min(ROWS, COLUMNS)
            dz_mm = (z - lz) * n_slices * SLICE_THICKNESS
            r_mm = lr_px * PIXEL_SPACING[0]
            if abs(dz_mm) < r_mm:
                r_here = np.sqrt(max(r_mm**2 - dz_mm**2, 0.0)) / PIXEL_SPACING[0]
                lx = cx + COLUMNS * (0.16 - 0.15 * i)
                ly = cy + ROWS * (0.10 * (i - 1))
                lesion = ((xx - lx) ** 2 + (yy - ly) ** 2) <= r_here**2
                sl[lesion & body] = hu

        sl[spine] = HU_BONE
        sl[ribs & body] = HU_BONE

        noise = rng.normal(0.0, NOISE_SIGMA_HU, size=(ROWS, COLUMNS)).astype(np.float32)
        sl[body] += noise[body]

        volume[k] = sl

    return np.clip(np.rint(volume), HU_MIN, HU_MAX).astype(np.int16)


def centreline_truth(n_slices: int) -> list[dict]:
    """Analytic vessel centreline in patient coordinates, one point per slice."""
    points = []
    for k in range(n_slices):
        z = k / max(n_slices - 1, 1)
        points.append(
            {
                "slice": k,
                "x_mm": HELIX_RX_MM * np.cos(2.0 * np.pi * z),
                "y_mm": HELIX_RY_MM * np.sin(2.0 * np.pi * z),
                "z_mm": k * SLICE_THICKNESS,
            }
        )
    return points


def _compress_series(out_dir: str) -> None:
    from pydicom import dcmread
    from pydicom.uid import JPEG2000Lossless

    for name in sorted(os.listdir(out_dir)):
        path = os.path.join(out_dir, name)
        ds = dcmread(path)
        ds.compress(JPEG2000Lossless)
        ds.save_as(path, enforce_file_format=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="./phantom")
    ap.add_argument("--slices", type=int, nargs="*", default=list(DEFAULT_SLICE_COUNTS))
    ap.add_argument("--compress", choices=["j2k"], default=None)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    manifest = []
    for n in args.slices:
        suffix = "_j2k" if args.compress else ""
        name = f"{PHANTOM_ID}_{n}{suffix}"
        out_dir = os.path.join(args.out, name)
        if os.path.exists(out_dir):
            if not args.force:
                print(f"skip (exists): {out_dir}", file=sys.stderr)
                continue
            shutil.rmtree(out_dir)

        print(f"building {name}: {n} slices", file=sys.stderr)
        volume = build_volume(n)
        write_series(
            volume,
            out_dir,
            series_description=name,
            patient_id=f"{PHANTOM_ID}_{n}",
            patient_name="GNBP^1B",
            pixel_spacing=PIXEL_SPACING,
            slice_thickness=SLICE_THICKNESS,
            series_number=n,
            uid_key=f"{PHANTOM_ID}-{PHANTOM_VERSION}-{n}-{args.compress or 'raw'}",
            # One study per slice count. Each size carries its own PatientID, so
            # they must not share a StudyInstanceUID: a study belongs to one
            # patient, and sharing one breaks the study list in the viewer.
            study_key=f"{PHANTOM_ID}-{PHANTOM_VERSION}-{n}-{args.compress or 'raw'}",
            study_description="GRAPHY-Next benchmark phantom",
            model_name=f"{PHANTOM_ID} v{PHANTOM_VERSION}",
            body_part="ABDOMEN",
            protocol_name="GNBP-1B performance phantom",
        )
        if args.compress == "j2k":
            _compress_series(out_dir)

        total = sum(os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir))
        md5 = series_checksum(out_dir)
        print(f"  {n} files, {total / 1024 / 1024:.1f} MiB, md5 {md5}", file=sys.stderr)
        manifest.append(
            {
                "series": name,
                "slices": n,
                "rows": ROWS,
                "columns": COLUMNS,
                "pixel_spacing_mm": list(PIXEL_SPACING),
                "slice_thickness_mm": SLICE_THICKNESS,
                "transfer_syntax": "JPEG2000Lossless" if args.compress else "ExplicitVRLittleEndian",
                "bytes_on_disk": total,
                "series_md5": md5,
            }
        )

    if manifest:
        path = os.path.join(args.out, f"{PHANTOM_ID}_manifest.json")
        existing = []
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                existing = json.load(fh).get("series", [])
        by_name = {s["series"]: s for s in existing}
        by_name.update({s["series"]: s for s in manifest})
        # 🚨 Windows の既定は cp932。encoding を省略すると非 ASCII で落ちる
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "phantom": PHANTOM_ID,
                    "version": PHANTOM_VERSION,
                    "purpose": "performance scaling with volume size",
                    "noise_sigma_hu": NOISE_SIGMA_HU,
                    "noise_seed": NOISE_SEED,
                    "vessel_centreline": {
                        "model": "helix; x = Rx cos(2 pi z / L), y = Ry sin(2 pi z / L)",
                        "rx_mm": HELIX_RX_MM,
                        "ry_mm": HELIX_RY_MM,
                        "vessel_radius_mm": VESSEL_RADIUS_MM,
                    },
                    "series": sorted(by_name.values(), key=lambda s: (s["series"])),
                },
                fh,
                indent=2,
            )
        print(f"  manifest -> {path}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

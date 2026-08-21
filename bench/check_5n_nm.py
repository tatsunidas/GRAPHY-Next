#!/usr/bin/env python3
# GRAPHY-Next Benchmark Phantom (GNBP-5N)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
#
"""Check that GNBP-5N's NM files carry the geometry GRAPHY will read back.

A multi-frame NM file can be perfectly valid DICOM and still be unopenable as a
volume, because NM keeps its geometry somewhere no other modality does: there is
no ImagePositionPatient at the root and none per frame, only a first-slice
position inside ``DetectorInformationSequence`` plus ``SpacingBetweenSlices``.
A reader has to stack the rest itself.

So "pydicom opened the file" proves nothing about whether the phantom is usable.
This script instead **re-implements what GRAPHY's NmFrameExpander does**
(``backend/src/main/java/com/vis/graphynext/dicom/NmFrameExpander.java``) and
checks two things:

  1. the expander's own preconditions hold — it would classify these files as
     tomographic and would find a position, an orientation and a spacing;

  2. the geometry so reconstructed **agrees with the published ground truth** —
     sampling the volume at a lesion's ``moving_mm``, using only coordinates
     derived from the DICOM header, actually lands on that lesion.

The second check is the one that matters. The generator's own self-check works
in its internal grid, so a mistake in the *writer* — an off-by-one in the first
slice position, a sign error on the normal, spacing written to the wrong tag —
would pass it and then show up much later as a constant offset that looks like a
registration bias. Here the truth is read from the JSON and the geometry from
the file, with nothing shared between them but the phantom itself.

    python3 check_5n_nm.py --phantom ./phantom
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

import numpy as np
import pydicom

# The success message contains an em dash, and a Windows console defaults to
# cp932/cp1252, which cannot encode it. Without this the script does all of its
# work, passes, and then dies with UnicodeEncodeError on the very last line —
# i.e. a passing check reports as a crash with a non-zero exit status. Reconfigure
# rather than de-Unicode the text, so the same message reads correctly everywhere.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


def is_nm_tomo(ds) -> bool:
    """Mirror of NmFrameExpander.isNmTomo."""
    if str(getattr(ds, "Modality", "")).upper() != "NM":
        return False
    if int(getattr(ds, "NumberOfFrames", 1)) <= 1:
        return False
    if int(getattr(ds, "NumberOfSlices", 0)) > 1:
        return True
    sv = getattr(ds, "SliceVector", None)
    if sv is not None and len(sv) > 1:
        return True
    types = [str(t).strip().upper() for t in getattr(ds, "ImageType", [])]
    return "RECON TOMO" in types


def first_detector(ds):
    seq = getattr(ds, "DetectorInformationSequence", None)
    return seq[0] if seq else None


def iop(ds):
    det = first_detector(ds)
    if det is not None:
        v = getattr(det, "ImageOrientationPatient", None)
        if v is not None and len(v) >= 6:
            return np.asarray(v, dtype=float)
    v = getattr(ds, "ImageOrientationPatient", None)
    return np.asarray(v, dtype=float) if v is not None else None


def origin_ipp(ds):
    det = first_detector(ds)
    if det is not None:
        v = getattr(det, "ImagePositionPatient", None)
        if v is not None and len(v) >= 3:
            return np.asarray(v, dtype=float)
    v = getattr(ds, "ImagePositionPatient", None)
    return np.asarray(v, dtype=float) if v is not None else None


def slice_spacing(ds) -> float:
    s = float(getattr(ds, "SpacingBetweenSlices", 0) or 0)
    if s > 0:
        return s
    return float(getattr(ds, "SliceThickness", 0) or 0)


def slice_index_of(ds, frame: int) -> int:
    sv = getattr(ds, "SliceVector", None)
    if sv is not None and 0 <= frame < len(sv) and int(sv[frame]) > 0:
        return int(sv[frame]) - 1
    return frame


def normal_of(orient) -> np.ndarray:
    r = np.asarray(orient[:3], dtype=float)
    c = np.asarray(orient[3:6], dtype=float)
    n = np.cross(r, c)
    length = np.linalg.norm(n)
    return n / length if length > 0 else np.array([0.0, 0.0, 1.0])


def frame_ipp(ds, frame: int) -> np.ndarray:
    """Mirror of NmFrameExpander.framePosition: origin + normal * spacing * slice."""
    return origin_ipp(ds) + normal_of(iop(ds)) * slice_spacing(ds) * slice_index_of(ds, frame)


def sample_world(ds, volume: np.ndarray, q: np.ndarray) -> float:
    """Trilinear value at patient point `q`, using ONLY header-derived geometry."""
    orient = iop(ds)
    row_dir = np.asarray(orient[:3], dtype=float)
    col_dir = np.asarray(orient[3:6], dtype=float)
    n = normal_of(orient)
    px, py = (float(v) for v in ds.PixelSpacing)
    origin = origin_ipp(ds)
    d = q - origin
    fx = float(d @ row_dir) / px
    fy = float(d @ col_dir) / py
    fz = float(d @ n) / slice_spacing(ds)

    nz, ny, nx = volume.shape
    if not (0 <= fx <= nx - 1 and 0 <= fy <= ny - 1 and 0 <= fz <= nz - 1):
        return float("nan")
    x0, y0, z0 = int(np.floor(fx)), int(np.floor(fy)), int(np.floor(fz))
    x1, y1, z1 = min(x0 + 1, nx - 1), min(y0 + 1, ny - 1), min(z0 + 1, nz - 1)
    tx, ty, tz = fx - x0, fy - y0, fz - z0
    v = volume.astype(np.float64)
    c00 = v[z0, y0, x0] * (1 - tx) + v[z0, y0, x1] * tx
    c01 = v[z0, y1, x0] * (1 - tx) + v[z0, y1, x1] * tx
    c10 = v[z1, y0, x0] * (1 - tx) + v[z1, y0, x1] * tx
    c11 = v[z1, y1, x0] * (1 - tx) + v[z1, y1, x1] * tx
    c0 = c00 * (1 - ty) + c01 * ty
    c1 = c10 * (1 - ty) + c11 * ty
    return float(c0 * (1 - tz) + c1 * tz)


# A lesion has to be large and bright enough that its presence is not in doubt
# before it can be used to test the geometry; otherwise a geometry failure and a
# partial-volume loss look the same.
GEOM_MIN_DIAMETER_MM = 25.0
GEOM_MIN_CNR = 5.0
GEOM_MIN_RATIO = 1.4

# The body centroid check below is the only geometry test the `t00` series can
# take: by design nothing in them is visible, so there is no lesion to look for.
# Without it those six series would be checked by header arithmetic alone —
# first-frame position and spacing — which never touches the pixel data and so
# cannot notice, say, a volume written with its frames in the opposite order.
CENTROID_TOLERANCE_MM = 4.0


def predicted_body_centroid(matrix_4x4, deformation) -> np.ndarray:
    """Centroid of the egg after the published transform, by direct sampling."""
    from make_phantom_5n import EGG_SEMI_AXES_MM, EGG_TAPER

    a, b, c = EGG_SEMI_AXES_MM
    n = 60
    ax = np.linspace(-a, a, n)
    ay = np.linspace(-b, b, n)
    az = np.linspace(-c, c, n)
    X, Y, Z = np.meshgrid(ax, ay, az, indexing="ij")
    zt = Z / c
    w = 1.0 + EGG_TAPER * zt
    safe = np.where(w > 1e-3, w, 1e-3)
    rho2 = (X / (a * safe)) ** 2 + (Y / (b * safe)) ** 2 + zt**2
    inside = (rho2 <= 1.0) & (w > 0.0)
    pts = np.stack([X[inside], Y[inside], Z[inside]], axis=-1)

    m = np.asarray(matrix_4x4, dtype=float).reshape(4, 4)
    q = pts @ m[:3, :3].T + m[:3, 3]
    if deformation:
        k = deformation["k_per_mm"]
        ampx, ampy, ampz = deformation["amplitude_mm"]
        x, y, z = q[:, 0], q[:, 1], q[:, 2]
        q = q + np.stack(
            [
                ampx * np.sin(k * y) * np.cos(k * z),
                ampy * np.sin(k * z) * np.cos(k * x),
                ampz * np.sin(k * x) * np.cos(k * y),
            ],
            axis=-1,
        )
    return q.mean(axis=0)


def measured_body_centroid(ds, volume: np.ndarray) -> np.ndarray:
    """Centroid of the thresholded body, in world coordinates from the header."""
    v = volume.astype(np.float64)
    # ★ Not "voxels above zero". The phantom writes a noisy floor outside the
    #   body, so `v > 0` selects almost the whole field of view and its median
    #   collapses to the air level — the mask would then swallow the air and the
    #   centroid would drift to the centre of the field of view instead of the
    #   body. Taking the median of the voxels above the *overall mean* lands
    #   firmly inside the body (which is bright and occupies ~9 % of the volume),
    #   and half of that separates body from air by more than an order of
    #   magnitude.
    bright = v[v > v.mean()]
    if bright.size < 1000:
        return np.array([np.nan] * 3)
    mask = v > 0.4 * np.median(bright)
    if mask.sum() < 1000:
        return np.array([np.nan] * 3)

    nz, ny, nx = v.shape
    orient = iop(ds)
    row_dir = np.asarray(orient[:3], dtype=float)
    col_dir = np.asarray(orient[3:6], dtype=float)
    n = normal_of(orient)
    px, py = (float(t) for t in ds.PixelSpacing)
    origin = origin_ipp(ds)

    zi, yi, xi = np.nonzero(mask)
    # Header-derived mapping only: origin + i*row*px + j*col*py + k*normal*spacing
    world = (
        origin
        + xi[:, None] * row_dir * px
        + yi[:, None] * col_dir * py
        + zi[:, None] * n * slice_spacing(ds)
    )
    return world.mean(axis=0)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--phantom", default="./phantom", help="directory holding GNBP-5N-*")
    args = ap.parse_args()

    truth_path = os.path.join(args.phantom, "GNBP-5N_ground_truth.json")
    if not os.path.exists(truth_path):
        print(f"no ground truth at {truth_path}; run make_phantom_5n.py first", file=sys.stderr)
        return 2
    with open(truth_path, encoding="utf-8") as fh:
        truth = json.load(fh)

    failures: list[str] = []
    centroid_offsets: list[tuple[str, float]] = []
    checked_series = 0
    checked_lesions = 0

    for name, entry in sorted(truth["series"].items()):
        series_dir = os.path.join(args.phantom, entry["series"])
        files = sorted(glob.glob(os.path.join(series_dir, "*.dcm")))
        if not files:
            failures.append(f"{name}: no files in {series_dir}")
            continue
        if len(files) != 1:
            failures.append(f"{name}: expected one multi-frame file, found {len(files)}")
            continue

        ds = pydicom.dcmread(files[0])
        checked_series += 1

        # --- 1. the expander's preconditions -----------------------------
        if not is_nm_tomo(ds):
            failures.append(f"{name}: isNmTomo() would be false — GRAPHY would open it as a cine")
            continue
        if iop(ds) is None:
            failures.append(f"{name}: no orientation in DetectorInformationSequence")
            continue
        if origin_ipp(ds) is None:
            failures.append(f"{name}: no position in DetectorInformationSequence")
            continue
        if slice_spacing(ds) <= 0:
            # NmFrameExpander refuses to invent coordinates without a spacing, so
            # the series would be treated as non-spatial and registration would
            # be disabled for it — with a correct-looking reason.
            failures.append(f"{name}: no SpacingBetweenSlices/SliceThickness")
            continue
        if "RescaleSlope" in ds or "RescaleIntercept" in ds:
            failures.append(f"{name}: NM must not carry a rescale pair (values are counts)")

        geom = entry["geometry"]
        n_frames = int(ds.NumberOfFrames)
        if n_frames != geom["slices"]:
            failures.append(f"{name}: NumberOfFrames {n_frames} != truth slices {geom['slices']}")
            continue

        # --- 2. reconstructed geometry vs the phantom's own grid ----------
        spacing = slice_spacing(ds)
        expected_first_z = -(geom["slices"] - 1) / 2.0 * geom["slice_thickness_mm"]
        got_first_z = float(frame_ipp(ds, 0)[2])
        if abs(got_first_z - expected_first_z) > 1e-6:
            failures.append(
                f"{name}: first frame z {got_first_z:.4f} != expected {expected_first_z:.4f}"
            )
        got_last_z = float(frame_ipp(ds, n_frames - 1)[2])
        expected_last_z = expected_first_z + (n_frames - 1) * geom["slice_thickness_mm"]
        if abs(got_last_z - expected_last_z) > 1e-6:
            failures.append(
                f"{name}: last frame z {got_last_z:.4f} != expected {expected_last_z:.4f}"
            )
        if abs(spacing - geom["slice_thickness_mm"]) > 1e-9:
            failures.append(f"{name}: spacing {spacing} != truth {geom['slice_thickness_mm']}")

        # --- 3. the truth and the header agree about where things are ----
        volume = ds.pixel_array  # (frames, rows, cols)
        by_id = {m["id"]: m for m in entry["lesion_measurements"]}
        used = 0
        for lm in entry["landmarks"]:
            m = by_id.get(lm["name"])
            if not m or not m["present"]:
                continue
            if (m["diameter_mm"] or 0) < GEOM_MIN_DIAMETER_MM:
                continue
            if (m["cnr"] or 0) < GEOM_MIN_CNR:
                continue
            q = np.asarray(lm["moving_mm"], dtype=float)
            at_lesion = sample_world(ds, volume, q)
            shell = m["shell_background_counts"]
            if not np.isfinite(at_lesion) or shell <= 0:
                continue
            used += 1
            checked_lesions += 1
            if at_lesion / shell < GEOM_MIN_RATIO:
                failures.append(
                    f"{name}/{lm['name']}: header geometry puts the lesion centre at "
                    f"{at_lesion:.1f} counts vs {shell:.1f} background "
                    f"({at_lesion / shell:.2f}x) — the written geometry and the published "
                    f"truth disagree"
                )
        # --- 4. body centroid: the geometry check that works without lesions --
        xf = entry["transform_fixed_to_moving"]
        want = predicted_body_centroid(xf["matrix_4x4_row_major"], xf.get("deformation"))
        got = measured_body_centroid(ds, volume)
        if not np.all(np.isfinite(got)):
            failures.append(f"{name}: could not measure a body centroid")
        else:
            offset = float(np.linalg.norm(got - want))
            if offset > CENTROID_TOLERANCE_MM:
                failures.append(
                    f"{name}: body centroid from the header is {offset:.2f} mm from the one the "
                    f"published transform predicts (limit {CENTROID_TOLERANCE_MM} mm) — "
                    f"got {np.round(got, 2).tolist()}, want {np.round(want, 2).tolist()}"
                )
            centroid_offsets.append((name, offset))

        if used == 0 and entry["content"] != "t00":
            failures.append(
                f"{name}: no lesion was usable for the geometry check — the check passed "
                f"without testing anything"
            )

    print(f"series checked: {checked_series}   lesion positions checked: {checked_lesions}")
    if centroid_offsets:
        worst = max(centroid_offsets, key=lambda t: t[1])
        mean_off = sum(o for _, o in centroid_offsets) / len(centroid_offsets)
        print(f"body centroid vs published transform: mean {mean_off:.2f} mm, "
              f"worst {worst[1]:.2f} mm ({worst[0]})")
    if failures:
        print(f"\nFAILED ({len(failures)}):", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print("OK — every series would expand to a spatial volume, and the geometry GRAPHY "
          "reconstructs from the header agrees with the published ground truth.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
# GRAPHY-Next Benchmark Phantom (GNBP-1)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
#
"""
GNBP-1A — GRAPHY-Next Benchmark Phantom, accuracy series.

A CT-encoded 3D Shepp-Logan head phantom plus an HU step wedge, generated so
that the *ground truth is analytic*: every ellipsoid has a closed-form volume
(4/3 pi a b c), closed-form principal-axis lengths, and a known HU value. The
series therefore measures correctness — 3D ROI volume, distance, and HU
calibration — rather than only load.

A purely synthetic load volume answers "is it fast?" but not "does it measure
correctly?". GNBP-1A answers the second question with numbers that can be
re-derived by hand from the parameter table.

Ellipsoid parameters: 3D Shepp-Logan, Toft/Schabel variant of the table in
Kak AC, Slaney M, "Principles of Computerized Tomographic Imaging", 1988,
Table 3.2 p.102 (with the published errata applied). The same table is used by
the widely circulated `phantom3d.m` and by tsadakane/sl3d; both were checked
against each other before transcription.

Partial-volume handling: the volume is supersampled SUPERSAMPLE^3 times per
output voxel and averaged. Without this, boundary voxels alias and the
"analytic truth" would not correspond to the written pixels, which would make
any accuracy claim meaningless at the boundary.

Usage:
    python3 make_phantom_a.py --out ./phantom
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

import numpy as np

from dicom_io import HU_MAX, HU_MIN, series_checksum, write_series

PHANTOM_ID = "GNBP-1A"
PHANTOM_VERSION = "1.0"

# --- Geometry of the written series -----------------------------------------
ROWS = COLUMNS = 512
PIXEL_SPACING = (0.5, 0.5)  # mm — 256 mm FOV, head-sized
SLICE_THICKNESS = 1.0  # mm — thin, so small ellipsoids are properly sampled
N_SLICES = 180  # covers z in [-90, +90] mm
SCALE_MM = 100.0  # Shepp-Logan unit -> mm (outer ellipsoid becomes 138x184x162 mm)
SUPERSAMPLE = 4  # per axis; 64 samples per output voxel

# --- HU mapping --------------------------------------------------------------
# Shepp-Logan intensities are dimensionless (0..1 for the modified variant).
# We map them linearly onto HU and record the map here so a reader can invert
# it. Air outside the phantom is forced to -1000 HU rather than following the
# linear map, so the surrounding空間 behaves like a real CT background.
HU_SLOPE = 1200.0
HU_OFFSET = -200.0
HU_AIR = -1000


def intensity_to_hu(intensity: np.ndarray | float) -> np.ndarray | float:
    return HU_SLOPE * intensity + HU_OFFSET


# --- 3D Shepp-Logan (modified / Toft-Schabel intensities) --------------------
# columns: A, a, b, c, x0, y0, z0, phi, theta, psi   (angles in degrees)
SHEPP_LOGAN_3D = [
    ("outer skull",      1.0, 0.6900, 0.920, 0.810,  0.00,  0.0000,  0.00,   0.0, 0.0,  0.0),
    ("inner skull",     -0.8, 0.6624, 0.874, 0.780,  0.00, -0.0184,  0.00,   0.0, 0.0,  0.0),
    ("right ventricle", -0.2, 0.1100, 0.310, 0.220,  0.22,  0.0000,  0.00, -18.0, 0.0, 10.0),
    ("left ventricle",  -0.2, 0.1600, 0.410, 0.280, -0.22,  0.0000,  0.00,  18.0, 0.0, 10.0),
    ("upper mass",       0.1, 0.2100, 0.250, 0.410,  0.00,  0.3500, -0.15,   0.0, 0.0,  0.0),
    ("nodule A",         0.1, 0.0460, 0.046, 0.050,  0.00,  0.1000,  0.25,   0.0, 0.0,  0.0),
    ("nodule B",         0.1, 0.0460, 0.046, 0.050,  0.00, -0.1000,  0.25,   0.0, 0.0,  0.0),
    ("nodule C",         0.1, 0.0460, 0.023, 0.050, -0.08, -0.6050,  0.00,   0.0, 0.0,  0.0),
    ("nodule D",         0.1, 0.0230, 0.023, 0.020,  0.00, -0.6060,  0.00,   0.0, 0.0,  0.0),
    ("nodule E",         0.1, 0.0230, 0.046, 0.020,  0.06, -0.6050,  0.00,   0.0, 0.0,  0.0),
]

# --- HU step wedge -----------------------------------------------------------
# Placed at |x| > 80 mm, i.e. always outside the outer ellipsoid (x semi-axis is
# 69 mm), so it cannot disturb the Shepp-Logan ground truth. Each bar is a
# 20 x 20 mm column running the full length of the stack.
STEP_WEDGE_HU = (-1000, -500, -100, 0, 100, 400, 1000)
WEDGE_X_MM = 95.0  # centre of the bars in x
WEDGE_SIZE_MM = 20.0
WEDGE_PITCH_MM = 26.0


def _rotation_matrix(phi_deg: float, theta_deg: float, psi_deg: float) -> np.ndarray:
    """ZXZ Euler rotation, matching the convention used by phantom3d.m."""
    phi, theta, psi = np.deg2rad([phi_deg, theta_deg, psi_deg])
    cphi, sphi = np.cos(phi), np.sin(phi)
    ctheta, stheta = np.cos(theta), np.sin(theta)
    cpsi, spsi = np.cos(psi), np.sin(psi)
    return np.array(
        [
            [cpsi * cphi - ctheta * sphi * spsi, cpsi * sphi + ctheta * cphi * spsi, spsi * stheta],
            [-spsi * cphi - ctheta * sphi * cpsi, -spsi * sphi + ctheta * cphi * cpsi, cpsi * stheta],
            [stheta * sphi, -stheta * cphi, ctheta],
        ]
    )


def _ellipsoids_mm() -> list[dict]:
    """The parameter table converted to millimetres, with analytic volumes."""
    out = []
    for name, A, a, b, c, x0, y0, z0, phi, theta, psi in SHEPP_LOGAN_3D:
        a_mm, b_mm, c_mm = a * SCALE_MM, b * SCALE_MM, c * SCALE_MM
        out.append(
            {
                "name": name,
                "intensity": A,
                "semi_axes_mm": [a_mm, b_mm, c_mm],
                "principal_axis_lengths_mm": [2 * a_mm, 2 * b_mm, 2 * c_mm],
                "center_mm": [x0 * SCALE_MM, y0 * SCALE_MM, z0 * SCALE_MM],
                "euler_deg_zxz": [phi, theta, psi],
                "volume_mm3": 4.0 / 3.0 * np.pi * a_mm * b_mm * c_mm,
            }
        )
    return out


def _net_intensity_at(point_mm: np.ndarray, ellipsoids: list[dict]) -> float:
    """Sum of the intensities of every ellipsoid containing `point_mm`."""
    total = 0.0
    for e in ellipsoids:
        d = point_mm - np.asarray(e["center_mm"])
        d = _rotation_matrix(*e["euler_deg_zxz"]) @ d
        if np.sum((d / np.asarray(e["semi_axes_mm"])) ** 2) <= 1.0:
            total += e["intensity"]
    return total


def build_volume(ellipsoids: list[dict]) -> np.ndarray:
    """Supersampled HU volume, shape (N_SLICES, ROWS, COLUMNS)."""
    ss = SUPERSAMPLE
    # Sub-sample offsets placed at cell centres, e.g. -3/8, -1/8, +1/8, +3/8.
    offs = (np.arange(ss) - (ss - 1) / 2.0) / ss

    x_centres = (np.arange(COLUMNS) - (COLUMNS - 1) / 2.0) * PIXEL_SPACING[0]
    y_centres = (np.arange(ROWS) - (ROWS - 1) / 2.0) * PIXEL_SPACING[1]
    z_centres = (np.arange(N_SLICES) - (N_SLICES - 1) / 2.0) * SLICE_THICKNESS

    xs = (x_centres[:, None] + offs[None, :] * PIXEL_SPACING[0]).ravel()  # COLUMNS*ss
    ys = (y_centres[:, None] + offs[None, :] * PIXEL_SPACING[1]).ravel()  # ROWS*ss

    volume = np.empty((N_SLICES, ROWS, COLUMNS), dtype=np.int16)

    rot = [_rotation_matrix(*e["euler_deg_zxz"]) for e in ellipsoids]
    cen = [np.asarray(e["center_mm"]) for e in ellipsoids]
    sem = [np.asarray(e["semi_axes_mm"]) for e in ellipsoids]

    XX, YY = np.meshgrid(xs, ys)  # (ROWS*ss, COLUMNS*ss)

    for k in range(N_SLICES):
        acc = np.zeros((ROWS * ss, COLUMNS * ss), dtype=np.float32)
        # Coverage of the outermost ellipsoid = the phantom's material support.
        # This is tracked separately because a net intensity of exactly zero is
        # a legitimate material value here (the ventricles are 1 - 0.8 - 0.2 = 0)
        # and must not be confused with "outside the phantom".
        sup = np.zeros((ROWS * ss, COLUMNS * ss), dtype=np.float32)
        for oz in offs:
            z = z_centres[k] + oz * SLICE_THICKNESS
            for e_i, e in enumerate(ellipsoids):
                # Bounding box in x/y for this ellipsoid at this z: skip the
                # (large) majority of samples that cannot be inside it.
                r = np.abs(rot[e_i]).T @ sem[e_i]  # conservative axis-aligned extent
                if abs(z - cen[e_i][2]) > r[2]:
                    continue
                xlo, xhi = cen[e_i][0] - r[0], cen[e_i][0] + r[0]
                ylo, yhi = cen[e_i][1] - r[1], cen[e_i][1] + r[1]
                ix = np.searchsorted(xs, [xlo, xhi])
                iy = np.searchsorted(ys, [ylo, yhi])
                if ix[0] >= ix[1] or iy[0] >= iy[1]:
                    continue

                sub_x = XX[iy[0] : iy[1], ix[0] : ix[1]]
                sub_y = YY[iy[0] : iy[1], ix[0] : ix[1]]
                dx = sub_x - cen[e_i][0]
                dy = sub_y - cen[e_i][1]
                dz = z - cen[e_i][2]
                R = rot[e_i]
                u = R[0, 0] * dx + R[0, 1] * dy + R[0, 2] * dz
                v = R[1, 0] * dx + R[1, 1] * dy + R[1, 2] * dz
                w = R[2, 0] * dx + R[2, 1] * dy + R[2, 2] * dz
                inside = (u / sem[e_i][0]) ** 2 + (v / sem[e_i][1]) ** 2 + (w / sem[e_i][2]) ** 2 <= 1.0
                acc[iy[0] : iy[1], ix[0] : ix[1]] += np.float32(e["intensity"]) * inside
                if e_i == 0:
                    sup[iy[0] : iy[1], ix[0] : ix[1]] += inside

        acc /= ss  # average over the sub-z samples
        sup /= ss

        # Average over the in-plane sub-samples: reshape and mean.
        block = acc.reshape(ROWS, ss, COLUMNS, ss).mean(axis=(1, 3))
        support = sup.reshape(ROWS, ss, COLUMNS, ss).mean(axis=(1, 3))

        # Intensity -> HU, mixing material and air by their volume fractions.
        # Fully inside  (support = 1): HU = slope * I + offset
        # Fully outside (support = 0): HU = HU_AIR
        # Boundary voxels get the volume-weighted mixture, which is what a real
        # reconstruction produces and what makes the partial-volume behaviour
        # well defined rather than aliased.
        hu = HU_SLOPE * block + HU_OFFSET * support + HU_AIR * (1.0 - support)

        _add_step_wedge(hu, x_centres, y_centres)

        volume[k] = np.clip(np.rint(hu), HU_MIN, HU_MAX).astype(np.int16)

    return volume


def _add_step_wedge(hu: np.ndarray, x_centres: np.ndarray, y_centres: np.ndarray) -> None:
    """Stamp the HU step wedge into a slice (in place). Sharp edges by design:
    the wedge measures HU calibration, not partial volume."""
    n = len(STEP_WEDGE_HU)
    y0 = -(n - 1) / 2.0 * WEDGE_PITCH_MM
    half = WEDGE_SIZE_MM / 2.0
    xm = np.abs(x_centres - WEDGE_X_MM) <= half
    for i, value in enumerate(STEP_WEDGE_HU):
        ym = np.abs(y_centres - (y0 + i * WEDGE_PITCH_MM)) <= half
        hu[np.ix_(ym, xm)] = value


def _wedge_ground_truth() -> list[dict]:
    n = len(STEP_WEDGE_HU)
    y0 = -(n - 1) / 2.0 * WEDGE_PITCH_MM
    return [
        {
            "index": i,
            "hu": value,
            "center_mm": [WEDGE_X_MM, y0 + i * WEDGE_PITCH_MM, None],
            "size_mm": [WEDGE_SIZE_MM, WEDGE_SIZE_MM, N_SLICES * SLICE_THICKNESS],
        }
        for i, value in enumerate(STEP_WEDGE_HU)
    ]


def measurement_targets(ellipsoids: list[dict]) -> list[dict]:
    """Homogeneous sampling regions with an analytically known HU.

    The two large ellipsoids are not homogeneous at their centres (the
    ventricles and the upper mass sit inside them), so they are probed at
    hand-picked points that are provably in a single material instead.
    """
    targets: list[dict] = []

    def probe(name: str, center: tuple[float, float, float], radius_mm: float, kind: str) -> None:
        net = _net_intensity_at(np.asarray(center), ellipsoids)
        targets.append(
            {
                "name": name,
                "kind": kind,
                "center_mm": list(center),
                "sample_radius_mm": radius_mm,
                "expected_hu": float(intensity_to_hu(net)),
            }
        )

    # Skull: between the outer and inner ellipsoids on the +y axis.
    probe("skull (shell)", (0.0, 89.0, 0.0), 2.0, "material")
    # Parenchyma: inside the inner ellipsoid, clear of every other object.
    probe("parenchyma", (0.0, 0.0, -50.0), 8.0, "material")

    # Every ellipsoid from the ventricles down is homogeneous at its centre.
    for e in ellipsoids[2:]:
        t = {
            "name": e["name"],
            "kind": "roi",
            "center_mm": list(e["center_mm"]),
            "sample_radius_mm": 0.4 * min(e["semi_axes_mm"]),
            "expected_hu": e["expected_hu"],
            "volume_mm3": e["volume_mm3"],
            "principal_axis_lengths_mm": e["principal_axis_lengths_mm"],
        }
        targets.append(t)

    # Step-wedge bars: exact HU by construction.
    for bar in _wedge_ground_truth():
        targets.append(
            {
                "name": f"wedge {bar['hu']:+d} HU",
                "kind": "calibration",
                "center_mm": [bar["center_mm"][0], bar["center_mm"][1], 0.0],
                "sample_radius_mm": 6.0,
                "expected_hu": float(bar["hu"]),
            }
        )

    return targets


def _verify(volume: np.ndarray, targets: list[dict]) -> list[dict]:
    """Measure the generated volume at each target and compare with the analytic
    value. This is a self-check of the generator, not of the viewer."""
    results = []
    x_centres = (np.arange(COLUMNS) - (COLUMNS - 1) / 2.0) * PIXEL_SPACING[0]
    y_centres = (np.arange(ROWS) - (ROWS - 1) / 2.0) * PIXEL_SPACING[1]
    z_centres = (np.arange(N_SLICES) - (N_SLICES - 1) / 2.0) * SLICE_THICKNESS

    for t in targets:
        cx, cy, cz = t["center_mm"]
        rad = t["sample_radius_mm"]
        ix = np.where(np.abs(x_centres - cx) <= rad)[0]
        iy = np.where(np.abs(y_centres - cy) <= rad)[0]
        iz = np.where(np.abs(z_centres - cz) <= rad)[0]
        if len(ix) == 0 or len(iy) == 0 or len(iz) == 0:
            continue
        core = volume[np.ix_(iz, iy, ix)].astype(np.float64)
        results.append(
            {
                "name": t["name"],
                "kind": t["kind"],
                "expected_hu": t["expected_hu"],
                "measured_hu_mean": float(core.mean()),
                "measured_hu_sd": float(core.std()),
                "n_voxels": int(core.size),
            }
        )
    return results


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="./phantom", help="output directory")
    ap.add_argument("--force", action="store_true", help="overwrite an existing series")
    args = ap.parse_args()

    out_dir = os.path.join(args.out, PHANTOM_ID)
    if os.path.exists(out_dir):
        if not args.force:
            print(f"skip (exists): {out_dir}", file=sys.stderr)
            return 0
        shutil.rmtree(out_dir)

    ellipsoids = _ellipsoids_mm()

    # Net HU inside each ellipsoid, evaluated analytically at its centre. For
    # the small non-overlapping nodules this value holds throughout the object.
    for e in ellipsoids:
        net = _net_intensity_at(np.asarray(e["center_mm"]), ellipsoids)
        e["net_intensity_at_center"] = net
        e["expected_hu"] = float(intensity_to_hu(net))

    print(f"building {PHANTOM_ID}: {N_SLICES} slices, {ROWS}x{COLUMNS}, "
          f"supersample {SUPERSAMPLE}^3", file=sys.stderr)
    volume = build_volume(ellipsoids)

    write_series(
        volume,
        out_dir,
        series_description=f"{PHANTOM_ID} SheppLogan accuracy",
        patient_id=PHANTOM_ID,
        patient_name="GNBP^1A",
        pixel_spacing=PIXEL_SPACING,
        slice_thickness=SLICE_THICKNESS,
        series_number=1,
        uid_key=f"{PHANTOM_ID}-{PHANTOM_VERSION}",
        # One study per phantom series. Sharing a StudyInstanceUID across series
        # that carry different PatientIDs is invalid DICOM — a study belongs to
        # one patient — and it breaks the study list in the viewer.
        study_key=f"{PHANTOM_ID}-{PHANTOM_VERSION}",
        study_description="GRAPHY-Next benchmark phantom",
        model_name=f"{PHANTOM_ID} v{PHANTOM_VERSION}",
        # Content is built about z = 0, so the written patient coordinates must
        # be too — otherwise the ground-truth z values are offset by half the
        # stack length relative to what the viewer reports.
        z_origin_mm=-(N_SLICES - 1) / 2.0 * SLICE_THICKNESS,
        body_part="HEAD",
        protocol_name="GNBP-1A accuracy phantom",
    )

    targets = measurement_targets(ellipsoids)
    checks = _verify(volume, targets)
    truth = {
        "phantom": PHANTOM_ID,
        "version": PHANTOM_VERSION,
        "purpose": "accuracy (volume / distance / HU) — analytic ground truth",
        "source": (
            "3D Shepp-Logan, Toft/Schabel intensities; geometry from Kak AC & Slaney M, "
            "Principles of Computerized Tomographic Imaging (1988), Table 3.2 p.102, errata applied"
        ),
        "geometry": {
            "rows": ROWS,
            "columns": COLUMNS,
            "slices": N_SLICES,
            "pixel_spacing_mm": list(PIXEL_SPACING),
            "slice_thickness_mm": SLICE_THICKNESS,
            "scale_mm_per_unit": SCALE_MM,
            "supersample_per_axis": SUPERSAMPLE,
        },
        "hu_map": {
            "formula": "HU = HU_SLOPE * net_intensity + HU_OFFSET",
            "hu_slope": HU_SLOPE,
            "hu_offset": HU_OFFSET,
            "air_hu_outside_phantom": HU_AIR,
        },
        "ellipsoids": ellipsoids,
        "step_wedge": _wedge_ground_truth(),
        "measurement_targets": targets,
        "generator_self_check": checks,
        "series_md5": series_checksum(out_dir),
    }

    truth_path = os.path.join(args.out, f"{PHANTOM_ID}_ground_truth.json")
    with open(truth_path, "w") as fh:
        json.dump(truth, fh, indent=2, ensure_ascii=False)

    total = sum(os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir))
    print(f"  {N_SLICES} files, {total / 1024 / 1024:.1f} MiB", file=sys.stderr)
    print(f"  ground truth -> {truth_path}", file=sys.stderr)
    print(f"  series md5   = {truth['series_md5']}", file=sys.stderr)
    print("\n  generator self-check (analytic vs generated):", file=sys.stderr)
    for c in checks:
        delta = c["measured_hu_mean"] - c["expected_hu"]
        print(f"    {c['name']:<16} expected {c['expected_hu']:>8.1f} HU  "
              f"measured {c['measured_hu_mean']:>8.1f} +/- {c['measured_hu_sd']:.1f}  "
              f"(delta {delta:+.1f})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

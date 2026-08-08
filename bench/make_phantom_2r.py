#!/usr/bin/env python3
# GRAPHY-Next Benchmark Phantom (GNBP-2R)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
#
"""
GNBP-2R — GRAPHY-Next Benchmark Phantom, registration series.

A fixed series and four moving series generated from the same 3D Shepp-Logan
content, each moved by a *known* transform. Because the transform is known in
closed form, the target registration error and the displacement-field error both
have exact ground truth — no manual landmark picking, no "looks aligned".

    GNBP-2R-fixed        reference (identity)
    GNBP-2R-rigid        known translation + rotation
    GNBP-2R-affine       rigid + anisotropic scale + shear
    GNBP-2R-deform       smooth analytic displacement field, |u| <= ~15 mm
    GNBP-2R-multimodal   rigid + non-monotonic intensity map + PSF + Poisson noise

Why the moving series are *not* produced by resampling the fixed series: doing
that would fold interpolation error into the data, and the "truth" would then be
truth-about-an-interpolation rather than truth about the anatomy. Here every
series is evaluated analytically at transformed coordinates, so fixed and moving
are both exact and the only error a registration measurement sees is its own.

DIRECTION CONVENTION (read this before using the ground truth)
--------------------------------------------------------------
Anatomy that sits at world point ``p`` in the fixed series sits at

    q = T(p)

in the moving series. ``T`` is what a registration must recover, and it is what
this file publishes as ground truth. It is also exactly the transform GRAPHY
feeds to ``computeFusionSlice(fg, bg, xf)`` as ``xf``: the resampler walks fixed
(background) voxels and needs the matching moving (foreground) point, i.e. it
needs ``T``. See ``fw/registration-design.md`` §2 and §4.1.

Generating the moving volume therefore uses the *inverse*: the moving voxel at
``q`` must contain the fixed content at ``T^-1(q)``. That inverse is applied
below; it is not the published truth. Confusing the two directions is the single
most likely way to get a phantom that silently rewards a wrong answer, which is
why both directions are spelled out here and re-checked by the generator
self-check (a nodule is measured at its predicted moving-space position).

Euler convention: ``R = Rz(rz) . Ry(ry) . Rx(rx)``, degrees, right-handed about
the patient LPS axes, rotation about the volume centre (the origin here). This
is the same convention as ``frontend/src/viewer/regTransform.ts``
(``mat4FromEulerDeg`` / ``manualAdjustToTransform``) — they must not drift apart,
or recovered parameters will not be comparable with the published ones.

Usage:
    python3 make_phantom_2r.py --out ./phantom
    python3 make_phantom_2r.py --out ./phantom --series rigid --force
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys

import numpy as np

from dicom_io import HU_MAX, HU_MIN, series_checksum, write_series
from make_phantom_a import (
    HU_AIR,
    HU_OFFSET,
    HU_SLOPE,
    _ellipsoids_mm,
    _net_intensity_at,
    _rotation_matrix,
    intensity_to_hu,
)

PHANTOM_ID = "GNBP-2R"
PHANTOM_VERSION = "1.0"

# --- Geometry of the written series -----------------------------------------
# Coarser than GNBP-1A (0.5 mm / 512^2 / 180) on purpose: registration accuracy
# is judged in millimetres against an analytic transform, not against voxel
# boundaries, and five series at GNBP-1A's resolution would cost ~450 MB and a
# long generation for no gain in what is being measured.
ROWS = COLUMNS = 256
N_SLICES = 176  # z in [-87.5, +87.5] mm — covers the 162 mm tall Shepp-Logan head
PIXEL_SPACING = (1.0, 1.0)
SLICE_THICKNESS = 1.0
SUPERSAMPLE = 2  # per axis; 8 samples per output voxel

# The multimodal series is written on a coarser grid, as a PET-like acquisition
# would be. Grid mismatch between fixed and moving is part of what it tests.
MM_ROWS = MM_COLUMNS = 128
MM_N_SLICES = 88
MM_PIXEL_SPACING = (2.0, 2.0)
MM_SLICE_THICKNESS = 2.0

# Rotation centre for every rigid/affine transform. The written series are
# centred on the origin (see `z_origin_mm` below), so the volume centre is the
# origin and the published parameters need no separate centre to be interpreted.
CENTRE_MM = np.zeros(3)


# ── Transform model ──────────────────────────────────────────────────────────


def euler_matrix(rx_deg: float, ry_deg: float, rz_deg: float) -> np.ndarray:
    """R = Rz . Ry . Rx, degrees, right-handed about the LPS axes.

    Mirrors `mat4FromEulerDeg` in frontend/src/viewer/regTransform.ts. Keep the
    two in step: the whole point of publishing rotation parameters is that the
    number GRAPHY reports can be compared with the number written here.
    """
    rx, ry, rz = np.deg2rad([rx_deg, ry_deg, rz_deg])
    cx, sx = np.cos(rx), np.sin(rx)
    cy, sy = np.cos(ry), np.sin(ry)
    cz, sz = np.cos(rz), np.sin(rz)
    return np.array(
        [
            [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
            [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
            [-sy, cy * sx, cy * cx],
        ]
    )


def affine_forward(linear: np.ndarray, translation: np.ndarray) -> np.ndarray:
    """4x4 forward transform T(p) = C + A.(p - C) + t, with C = CENTRE_MM."""
    m = np.eye(4)
    m[:3, :3] = linear
    m[:3, 3] = CENTRE_MM + translation - linear @ CENTRE_MM
    return m


# --- Rigid -------------------------------------------------------------------
# Values chosen to be awkward on purpose: no round numbers, no zero component,
# and a translation larger than the slice thickness in every axis, so an engine
# cannot look good by accident (a "0.0 mm" answer is never nearly right here).
RIGID_TRANSLATION_MM = (7.3, -4.1, 11.6)
RIGID_EULER_DEG = (3.2, -1.7, 5.5)

# --- Affine ------------------------------------------------------------------
# Rigid, then anisotropic scale, then shear. Scale is deliberately small (a few
# percent): large scale would make the affine case easier than the rigid one,
# because scale is the parameter a similarity metric picks up first.
AFFINE_SCALE = (1.05, 0.97, 1.02)
AFFINE_SHEAR_XY = 0.03  # x gains 0.03 * y
AFFINE_SHEAR_XZ = -0.02  # x gains -0.02 * z
AFFINE_TRANSLATION_MM = (-5.8, 6.4, -3.7)
AFFINE_EULER_DEG = (-2.4, 3.1, -4.2)

# --- Deformable --------------------------------------------------------------
# A tensor product of sinusoids rather than the B-spline the design first
# sketched (`fw/registration-design.md` §9.1). The reason is reproducibility by a
# third party: this field is three lines of closed form that anyone can evaluate
# anywhere, its Jacobian is analytic (so "no folding" is proved, not sampled),
# and it needs no random seed or B-spline evaluator to reproduce. The engine
# under test (R4) still uses its own B-spline/DVF representation — the truth
# field does not have to share it.
#
#   u_x(p) = Ax . sin(k.y) . cos(k.z)
#   u_y(p) = Ay . sin(k.z) . cos(k.x)
#   u_z(p) = Az . sin(k.x) . cos(k.y)
#
# Amplitudes are capped so that max|u| stays near the 15 mm the design asked for
# while the Jacobian determinant stays comfortably positive (checked below).
DEFORM_WAVELENGTH_MM = 180.0
DEFORM_AMPLITUDE_MM = (9.0, 7.0, 11.0)
# Rigid part carried by the deformable case as well: a pure deformation with no
# global offset is an unrealistically kind starting point.
DEFORM_TRANSLATION_MM = (3.5, -2.6, 4.9)
DEFORM_EULER_DEG = (1.8, -1.2, 2.6)

# --- Multimodal --------------------------------------------------------------
MM_TRANSLATION_MM = (-6.2, 8.7, -9.4)
MM_EULER_DEG = (2.7, 4.3, -3.6)
# HU -> pseudo-activity, deliberately NON-monotonic. A monotone map leaves the
# problem solvable by NCC, which would not test a multimodal metric at all. Here
# bone (high HU) is *low* uptake and the nodules (160 HU) are the *highest*, so
# the intensity ordering between bone and soft tissue is inverted, as it is
# between CT and FDG-PET.
MM_HU_KNOTS = (-1000.0, -200.0, 0.0, 40.0, 160.0, 400.0, 1000.0)
# The activity scale is set so that the Poisson tail stays inside the range the
# CT encoding can hold (HU_MAX = 3071 with a -1024 intercept). An earlier scale
# peaking at 2600 clipped the bright tail, which quietly truncates the intensity
# distribution the multimodal metric is supposed to be tested against. The
# generator now checks that nothing clips rather than trusting the arithmetic.
MM_ACTIVITY_KNOTS = (0.0, 90.0, 550.0, 700.0, 1200.0, 420.0, 140.0)
MM_PSF_FWHM_MM = 5.0
MM_POISSON_SCALE = 0.02  # counts per activity unit; lower = noisier
MM_NOISE_SEED = 20260808


def deform_displacement(p: np.ndarray) -> np.ndarray:
    """u(p) for the analytic deformation. `p` is (..., 3) in mm; returns (..., 3)."""
    k = 2.0 * np.pi / DEFORM_WAVELENGTH_MM
    ax, ay, az = DEFORM_AMPLITUDE_MM
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    u = np.empty_like(p)
    u[..., 0] = ax * np.sin(k * y) * np.cos(k * z)
    u[..., 1] = ay * np.sin(k * z) * np.cos(k * x)
    u[..., 2] = az * np.sin(k * x) * np.cos(k * y)
    return u


def deform_jacobian_det(p: np.ndarray) -> np.ndarray:
    """det(I + du/dp), evaluated in closed form. `p` is (..., 3)."""
    k = 2.0 * np.pi / DEFORM_WAVELENGTH_MM
    ax, ay, az = DEFORM_AMPLITUDE_MM
    x, y, z = p[..., 0], p[..., 1], p[..., 2]

    # du_x/dy, du_x/dz  (du_x/dx = 0), and so on round the cycle.
    dxy = ax * k * np.cos(k * y) * np.cos(k * z)
    dxz = -ax * k * np.sin(k * y) * np.sin(k * z)
    dyz = ay * k * np.cos(k * z) * np.cos(k * x)
    dyx = -ay * k * np.sin(k * z) * np.sin(k * x)
    dzx = az * k * np.cos(k * x) * np.cos(k * y)
    dzy = -az * k * np.sin(k * x) * np.sin(k * y)

    # | 1    dxy  dxz |
    # | dyx  1    dyz |
    # | dzx  dzy  1   |
    return (
        1.0 * (1.0 - dyz * dzy)
        - dxy * (dyx - dyz * dzx)
        + dxz * (dyx * dzy - dzx)
    )


class Warp:
    """A forward transform T (fixed -> moving) plus the inverse used to generate.

    `forward` is the ground truth. `inverse` is generation machinery.
    """

    def __init__(self, name: str, matrix: np.ndarray, deformable: bool = False):
        self.name = name
        self.matrix = matrix  # 4x4, the rigid/affine part of T
        self.inv_matrix = np.linalg.inv(matrix)
        self.deformable = deformable

    def forward(self, p: np.ndarray) -> np.ndarray:
        """T(p): where fixed-space point `p` ends up in the moving series."""
        q = p @ self.matrix[:3, :3].T + self.matrix[:3, 3]
        if self.deformable:
            q = q + deform_displacement(q)
        return q

    def inverse(self, q: np.ndarray, tol_mm: float = 1e-9, max_iters: int = 50) -> np.ndarray:
        """T^-1(q). The deformable part is inverted by fixed-point iteration.

        Convergence needs the displacement to be a contraction; the amplitudes
        above keep max|du/dp| well below 1. Iteration stops on the measured step
        size rather than a fixed count — a fixed count is either wasteful (this
        converges to machine precision in a handful of steps, and the generator
        runs it once per supersample of every voxel) or silently wrong if the
        amplitudes are ever raised. The achieved residual is published in the
        truth file, so "it converged" is a number, not an assumption.
        """
        r = q
        if self.deformable:
            r = q.copy()
            for _ in range(max_iters):
                nxt = q - deform_displacement(r)
                step = np.abs(nxt - r).max()
                r = nxt
                if step < tol_mm:
                    break
        return r @ self.inv_matrix[:3, :3].T + self.inv_matrix[:3, 3]


def build_warps() -> dict[str, Warp]:
    rigid = affine_forward(euler_matrix(*RIGID_EULER_DEG), np.asarray(RIGID_TRANSLATION_MM))

    shear = np.eye(3)
    shear[0, 1] = AFFINE_SHEAR_XY
    shear[0, 2] = AFFINE_SHEAR_XZ
    linear_affine = shear @ np.diag(AFFINE_SCALE) @ euler_matrix(*AFFINE_EULER_DEG)
    affine = affine_forward(linear_affine, np.asarray(AFFINE_TRANSLATION_MM))

    deform = affine_forward(euler_matrix(*DEFORM_EULER_DEG), np.asarray(DEFORM_TRANSLATION_MM))
    multimodal = affine_forward(euler_matrix(*MM_EULER_DEG), np.asarray(MM_TRANSLATION_MM))

    return {
        "fixed": Warp("fixed", np.eye(4)),
        "rigid": Warp("rigid", rigid),
        "affine": Warp("affine", affine),
        "deform": Warp("deform", deform, deformable=True),
        "multimodal": Warp("multimodal", multimodal),
    }


# ── Volume generation ────────────────────────────────────────────────────────


def _grid_centres(n: int, spacing: float) -> np.ndarray:
    """Voxel-centre coordinates of an axis, centred on 0 — matching write_series."""
    return (np.arange(n) - (n - 1) / 2.0) * spacing


def build_volume(
    warp: Warp,
    *,
    rows: int,
    columns: int,
    n_slices: int,
    pixel_spacing: tuple[float, float],
    slice_thickness: float,
    supersample: int = SUPERSAMPLE,
) -> np.ndarray:
    """HU volume of the Shepp-Logan content moved by `warp`, shape (z, y, x).

    The bounding-box shortcut GNBP-1A uses is not available here: once the sample
    points are warped they no longer lie on a sorted axis-aligned grid, so every
    ellipsoid is evaluated over every sample. That is the price of keeping the
    moving series analytic instead of interpolated, and it is the right trade —
    an interpolated moving series would make the ground truth approximate.
    """
    ellipsoids = _ellipsoids_mm()
    rot = [_rotation_matrix(*e["euler_deg_zxz"]) for e in ellipsoids]
    cen = [np.asarray(e["center_mm"]) for e in ellipsoids]
    sem = [np.asarray(e["semi_axes_mm"]) for e in ellipsoids]

    ss = supersample
    offs = (np.arange(ss) - (ss - 1) / 2.0) / ss

    x_centres = _grid_centres(columns, pixel_spacing[0])
    y_centres = _grid_centres(rows, pixel_spacing[1])
    z_centres = _grid_centres(n_slices, slice_thickness)

    xs = (x_centres[:, None] + offs[None, :] * pixel_spacing[0]).ravel()
    ys = (y_centres[:, None] + offs[None, :] * pixel_spacing[1]).ravel()
    XX, YY = np.meshgrid(xs, ys)  # (rows*ss, columns*ss)

    volume = np.empty((n_slices, rows, columns), dtype=np.int16)
    pts = np.empty(XX.shape + (3,), dtype=np.float64)
    pts[..., 0] = XX
    pts[..., 1] = YY

    for k in range(n_slices):
        acc = np.zeros(XX.shape, dtype=np.float32)
        sup = np.zeros(XX.shape, dtype=np.float32)

        for oz in offs:
            pts[..., 2] = z_centres[k] + oz * slice_thickness
            # Moving voxel at `pts` holds the fixed content at T^-1(pts).
            src = warp.inverse(pts)
            sx, sy, sz = src[..., 0], src[..., 1], src[..., 2]

            for e_i in range(len(ellipsoids)):
                dx = sx - cen[e_i][0]
                dy = sy - cen[e_i][1]
                dz = sz - cen[e_i][2]
                R = rot[e_i]
                u = R[0, 0] * dx + R[0, 1] * dy + R[0, 2] * dz
                v = R[1, 0] * dx + R[1, 1] * dy + R[1, 2] * dz
                w = R[2, 0] * dx + R[2, 1] * dy + R[2, 2] * dz
                inside = (
                    (u / sem[e_i][0]) ** 2 + (v / sem[e_i][1]) ** 2 + (w / sem[e_i][2]) ** 2
                ) <= 1.0
                acc += np.float32(ellipsoids[e_i]["intensity"]) * inside
                if e_i == 0:
                    sup += inside

        acc /= ss
        sup /= ss
        block = acc.reshape(rows, ss, columns, ss).mean(axis=(1, 3))
        support = sup.reshape(rows, ss, columns, ss).mean(axis=(1, 3))
        # Same partial-volume mixing as GNBP-1A: material and air by volume
        # fraction, so boundary voxels are defined rather than aliased.
        hu = HU_SLOPE * block + HU_OFFSET * support + HU_AIR * (1.0 - support)
        volume[k] = np.clip(np.rint(hu), HU_MIN, HU_MAX).astype(np.int16)

    return volume


# ── Multimodal post-processing ───────────────────────────────────────────────


def hu_to_activity(hu: np.ndarray) -> np.ndarray:
    """Piecewise-linear, non-monotonic HU -> pseudo-activity map."""
    return np.interp(hu, MM_HU_KNOTS, MM_ACTIVITY_KNOTS)


def _gaussian_blur(vol: np.ndarray, sigma_vox: tuple[float, float, float]) -> np.ndarray:
    """Separable Gaussian blur. Written out rather than pulled from scipy: the
    bench generators depend only on numpy/pydicom, and adding a dependency for
    one convolution would make the phantom harder to reproduce, not easier."""
    out = vol.astype(np.float64)
    for axis, sigma in enumerate(sigma_vox):
        if sigma <= 0:
            continue
        radius = max(1, int(np.ceil(3.0 * sigma)))
        t = np.arange(-radius, radius + 1)
        kernel = np.exp(-0.5 * (t / sigma) ** 2)
        kernel /= kernel.sum()
        pad = [(0, 0)] * out.ndim
        pad[axis] = (radius, radius)
        padded = np.pad(out, pad, mode="edge")
        acc = np.zeros_like(out)
        for i, wgt in enumerate(kernel):
            sl = [slice(None)] * out.ndim
            sl[axis] = slice(i, i + out.shape[axis])
            acc += wgt * padded[tuple(sl)]
        out = acc
    return out


def to_pseudo_pet(hu_volume: np.ndarray, spacing: tuple[float, float, float]) -> np.ndarray:
    """HU volume -> pseudo-PET: non-monotonic map, PSF, Poisson noise.

    Without the PSF and the noise the "PET" is just a recoloured CT and every
    metric solves it too easily; the difficulty a multimodal metric has to cope
    with comes from the blur and the counting statistics, not from the colours.
    """
    activity = hu_to_activity(hu_volume.astype(np.float64))
    sigma_mm = MM_PSF_FWHM_MM / (2.0 * np.sqrt(2.0 * np.log(2.0)))
    blurred = _gaussian_blur(activity, tuple(sigma_mm / s for s in spacing))
    rng = np.random.default_rng(MM_NOISE_SEED)
    noisy = rng.poisson(np.clip(blurred, 0, None) * MM_POISSON_SCALE) / MM_POISSON_SCALE
    rounded = np.rint(noisy)
    # Clipping here would truncate the bright tail of the Poisson distribution,
    # i.e. change the very statistics this series exists to present. Fail loudly
    # instead: the fix is the activity scale, not a silent clamp.
    if rounded.max() > HU_MAX or rounded.min() < 0:
        raise SystemExit(
            f"pseudo-PET values leave the encodable range "
            f"[{0}, {HU_MAX}] (got {rounded.min():.0f}..{rounded.max():.0f}); "
            "lower MM_ACTIVITY_KNOTS"
        )
    return rounded.astype(np.int16)


# ── Ground truth and self-check ──────────────────────────────────────────────


def landmarks(warp: Warp) -> list[dict]:
    """Ellipsoid centres as registration landmarks, in both spaces.

    Centres are used rather than hand-picked points because they are exactly
    known and because their expected HU is known too, which is what lets the
    self-check confirm the direction convention instead of assuming it.
    """
    out = []
    for e in _ellipsoids_mm():
        p = np.asarray(e["center_mm"])
        out.append(
            {
                "name": e["name"],
                "fixed_mm": [float(v) for v in p],
                "moving_mm": [float(v) for v in warp.forward(p[None, :])[0]],
            }
        )
    return out


def displacement_summary(warp: Warp) -> dict:
    """|T(p) - p| over the written grid, plus the Jacobian check for deformables."""
    x = _grid_centres(COLUMNS, PIXEL_SPACING[0])[::8]
    y = _grid_centres(ROWS, PIXEL_SPACING[1])[::8]
    z = _grid_centres(N_SLICES, SLICE_THICKNESS)[::4]
    grid = np.stack(np.meshgrid(x, y, z, indexing="ij"), axis=-1).reshape(-1, 3)

    disp = np.linalg.norm(warp.forward(grid) - grid, axis=-1)
    summary = {
        "sampled_points": int(grid.shape[0]),
        "displacement_mm_mean": float(disp.mean()),
        "displacement_mm_max": float(disp.max()),
        "displacement_mm_p95": float(np.percentile(disp, 95)),
    }
    if warp.deformable:
        det = deform_jacobian_det(grid)
        summary["jacobian_det_min"] = float(det.min())
        summary["jacobian_det_max"] = float(det.max())
        summary["jacobian_negative_fraction"] = float((det <= 0).mean())
        # Folding is not a "worse score", it is a broken phantom: a displacement
        # field that folds has no inverse and the fixed-point inversion used to
        # generate the volume would not converge.
        if det.min() <= 0:
            raise SystemExit("deformation folds (min |J| <= 0); reduce DEFORM_AMPLITUDE_MM")
        resid = np.linalg.norm(warp.forward(warp.inverse(grid)) - grid, axis=-1)
        summary["inverse_residual_mm_max"] = float(resid.max())
    return summary


SELF_CHECK_TOLERANCE_HU = 25.0


def self_check(volume: np.ndarray, warp: Warp, geom: dict, *, assert_hu: bool) -> list[dict]:
    """Measure the generated moving volume at each landmark's predicted position.

    This is the check that catches a flipped direction convention, and it is the
    reason the landmarks are ellipsoid centres: their expected HU is known, so
    "is the nodule actually there?" is a number rather than an impression. If
    `moving_mm` were computed with T^-1 by mistake, the reading would be the
    surrounding parenchyma (40 HU) instead of the nodule (160 HU) and the run
    fails here rather than months later during an accuracy argument.

    `assert_hu` is off for the multimodal series, whose voxels hold pseudo-
    activity rather than HU; there the reading is reported but not judged.
    """
    x_c = _grid_centres(geom["columns"], geom["pixel_spacing_mm"])
    y_c = _grid_centres(geom["rows"], geom["pixel_spacing_mm"])
    z_c = _grid_centres(geom["slices"], geom["slice_thickness_mm"])

    ellipsoids = _ellipsoids_mm()
    results = []
    failures = []
    for e, lm in zip(ellipsoids, landmarks(warp)):
        # Only the small, homogeneous nodules give a clean single-value reading;
        # the big overlapping ellipsoids do not have one expected HU at centre.
        if not e["name"].startswith("nodule"):
            continue
        qx, qy, qz = lm["moving_mm"]
        if not (x_c[0] <= qx <= x_c[-1] and y_c[0] <= qy <= y_c[-1] and z_c[0] <= qz <= z_c[-1]):
            continue  # moved outside the written field of view
        ix = int(np.argmin(np.abs(x_c - qx)))
        iy = int(np.argmin(np.abs(y_c - qy)))
        iz = int(np.argmin(np.abs(z_c - qz)))
        expected = float(intensity_to_hu(_net_intensity_at(np.asarray(e["center_mm"]), ellipsoids)))
        measured = float(volume[iz, iy, ix])
        ok = abs(measured - expected) <= SELF_CHECK_TOLERANCE_HU
        results.append(
            {
                "name": e["name"],
                "moving_mm": lm["moving_mm"],
                "voxel": [ix, iy, iz],
                "expected_hu": expected,
                "measured_hu": measured,
                "within_tolerance": bool(ok) if assert_hu else None,
            }
        )
        if assert_hu and not ok:
            failures.append(f"{e['name']}: expected {expected:.0f} HU, measured {measured:.0f} HU")

    if failures:
        raise SystemExit(
            "generator self-check failed — the landmark truth does not match the written "
            "volume, which usually means the fixed->moving direction is inverted:\n  "
            + "\n  ".join(failures)
        )
    return results


# ── Series definitions ───────────────────────────────────────────────────────

SERIES = {
    "fixed": {
        "number": 1,
        "description": "GNBP-2R fixed (reference)",
        "kind": "identity",
    },
    "rigid": {
        "number": 2,
        "description": "GNBP-2R moving rigid",
        "kind": "rigid",
    },
    "affine": {
        "number": 3,
        "description": "GNBP-2R moving affine",
        "kind": "affine",
    },
    "deform": {
        "number": 4,
        "description": "GNBP-2R moving deformable",
        "kind": "deformable",
    },
    "multimodal": {
        "number": 5,
        "description": "GNBP-2R moving multimodal (pseudo-PET, CT-encoded)",
        "kind": "rigid + non-monotonic intensity + PSF + Poisson",
    },
}


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--out", default="./phantom", help="output directory")
    ap.add_argument("--force", action="store_true", help="overwrite existing series")
    ap.add_argument(
        "--series",
        choices=sorted(SERIES),
        action="append",
        help="generate only these series (repeatable); default is all",
    )
    args = ap.parse_args()

    wanted = args.series or list(SERIES)
    warps = build_warps()
    truth_series = {}

    for name in SERIES:
        if name not in wanted:
            continue
        spec = SERIES[name]
        warp = warps[name]
        series_id = f"{PHANTOM_ID}-{name}"
        out_dir = os.path.join(args.out, series_id)
        if os.path.exists(out_dir):
            if not args.force:
                print(f"skip (exists): {out_dir}", file=sys.stderr)
                continue
            shutil.rmtree(out_dir)

        multimodal = name == "multimodal"
        rows = MM_ROWS if multimodal else ROWS
        columns = MM_COLUMNS if multimodal else COLUMNS
        n_slices = MM_N_SLICES if multimodal else N_SLICES
        spacing = MM_PIXEL_SPACING if multimodal else PIXEL_SPACING
        thickness = MM_SLICE_THICKNESS if multimodal else SLICE_THICKNESS

        print(f"building {series_id}: {n_slices} slices, {rows}x{columns}", file=sys.stderr)
        volume = build_volume(
            warp,
            rows=rows,
            columns=columns,
            n_slices=n_slices,
            pixel_spacing=spacing,
            slice_thickness=thickness,
        )
        if multimodal:
            volume = to_pseudo_pet(volume, (thickness, spacing[1], spacing[0]))

        write_series(
            volume,
            out_dir,
            series_description=spec["description"],
            patient_id=PHANTOM_ID,
            patient_name="GNBP^2R",
            pixel_spacing=spacing,
            slice_thickness=thickness,
            series_number=spec["number"],
            uid_key=f"{series_id}-{PHANTOM_VERSION}",
            # One study holding every series, so the pair can be opened and fused
            # in the viewer without any import gymnastics.
            study_key=f"{PHANTOM_ID}-{PHANTOM_VERSION}",
            study_description="GRAPHY-Next registration benchmark phantom",
            model_name=f"{series_id} v{PHANTOM_VERSION}",
            z_origin_mm=-(n_slices - 1) / 2.0 * thickness,
            body_part="HEAD",
            protocol_name=f"{PHANTOM_ID} registration phantom",
            # The multimodal series declares a different frame of reference, as a
            # separately-acquired PET would. That is what exercises an engine's
            # "same FoR -> start from identity" branch in both directions.
            frame_of_reference_key=(
                f"{PHANTOM_ID}-{PHANTOM_VERSION}-mm" if multimodal else None
            ),
        )

        geom = {
            "rows": rows,
            "columns": columns,
            "slices": n_slices,
            "pixel_spacing_mm": spacing[0],
            "slice_thickness_mm": thickness,
        }
        entry = {
            "series": series_id,
            "series_number": spec["number"],
            "kind": spec["kind"],
            "geometry": geom,
            "transform_fixed_to_moving": {
                "matrix_4x4_row_major": [float(v) for v in warp.matrix.ravel()],
                "rotation_centre_mm": [float(v) for v in CENTRE_MM],
            },
            "landmarks": landmarks(warp),
            "displacement": displacement_summary(warp),
            "series_md5": series_checksum(out_dir),
        }
        if name in ("rigid", "affine", "deform", "multimodal"):
            params = {
                "rigid": (RIGID_TRANSLATION_MM, RIGID_EULER_DEG),
                "affine": (AFFINE_TRANSLATION_MM, AFFINE_EULER_DEG),
                "deform": (DEFORM_TRANSLATION_MM, DEFORM_EULER_DEG),
                "multimodal": (MM_TRANSLATION_MM, MM_EULER_DEG),
            }[name]
            entry["transform_fixed_to_moving"]["translation_mm"] = list(params[0])
            entry["transform_fixed_to_moving"]["euler_deg_rz_ry_rx_applied_as_Rz_Ry_Rx"] = list(params[1])
        if name == "affine":
            entry["transform_fixed_to_moving"]["scale"] = list(AFFINE_SCALE)
            entry["transform_fixed_to_moving"]["shear_xy"] = AFFINE_SHEAR_XY
            entry["transform_fixed_to_moving"]["shear_xz"] = AFFINE_SHEAR_XZ
        if name == "deform":
            entry["transform_fixed_to_moving"]["deformation"] = {
                "form": "u_x = Ax sin(k y) cos(k z); u_y = Ay sin(k z) cos(k x); u_z = Az sin(k x) cos(k y)",
                "applied": "after the rigid part: T(p) = M p + u(M p)",
                "k_per_mm": 2.0 * np.pi / DEFORM_WAVELENGTH_MM,
                "wavelength_mm": DEFORM_WAVELENGTH_MM,
                "amplitude_mm": list(DEFORM_AMPLITUDE_MM),
            }
        if multimodal:
            entry["intensity_map"] = {
                "note": "non-monotonic HU -> pseudo-activity; bone is low, nodules are highest",
                "hu_knots": list(MM_HU_KNOTS),
                "activity_knots": list(MM_ACTIVITY_KNOTS),
                "psf_fwhm_mm": MM_PSF_FWHM_MM,
                "poisson_scale": MM_POISSON_SCALE,
                "noise_seed": MM_NOISE_SEED,
                "encoding": "written as CT (HU-encoded) — PT/MR series arrive with GNBP-3S",
            }
        entry["generator_self_check"] = self_check(volume, warp, geom, assert_hu=not multimodal)
        truth_series[name] = entry

        total = sum(os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir))
        print(f"  {n_slices} files, {total / 1024 / 1024:.1f} MiB, md5 {entry['series_md5']}",
              file=sys.stderr)
        for c in entry["generator_self_check"]:
            print(f"    {c['name']:<10} at moving {np.round(c['moving_mm'], 1)} -> "
                  f"{c['measured_hu']:.0f} HU", file=sys.stderr)

    truth_path = os.path.join(args.out, f"{PHANTOM_ID}_ground_truth.json")
    existing = {}
    if os.path.exists(truth_path):
        with open(truth_path) as fh:
            existing = json.load(fh).get("series", {})
    existing.update(truth_series)

    truth = {
        "phantom": PHANTOM_ID,
        "version": PHANTOM_VERSION,
        "purpose": "registration accuracy (rigid / affine / deformable / multimodal) — analytic ground truth",
        "content": "3D Shepp-Logan (see GNBP-1A_ground_truth.json for the ellipsoid table); no step wedge",
        "direction_convention": (
            "transform_fixed_to_moving maps a point of the FIXED series to the point of the "
            "MOVING series holding the same anatomy: q = T(p). This is the transform a "
            "registration must recover, and the one GRAPHY passes to computeFusionSlice as xf."
        ),
        "euler_convention": (
            "R = Rz(rz) . Ry(ry) . Rx(rx), degrees, right-handed about patient LPS, about "
            "rotation_centre_mm; identical to mat4FromEulerDeg in frontend/src/viewer/regTransform.ts"
        ),
        "acceptance_targets": {
            "rigid_translation_error_mm": 0.5,
            "rigid_rotation_error_deg": 0.2,
            "deformable_displacement_rmse_mm": 1.0,
            "jacobian_negative_fraction": 0.0,
            "note": "from fw/registration-design.md §9.1/§9.4; revisit once R8 has measured numbers",
        },
        "series": existing,
    }
    with open(truth_path, "w") as fh:
        json.dump(truth, fh, indent=2, ensure_ascii=False)
    print(f"  ground truth -> {truth_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

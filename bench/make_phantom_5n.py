#!/usr/bin/env python3
# GRAPHY-Next Benchmark Phantom (GNBP-5N)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
#
"""GNBP-5N — longitudinal SPECT (NM) registration phantom.

The other registration phantom, GNBP-2R, answers "can the engine recover a known
transform?". This one answers a question GNBP-2R cannot ask: **what happens when
the two series no longer show the same thing?**

That is the situation of a therapy follow-up SPECT. Between the two scans lesions
appear, change size and — if the treatment worked — disappear. Every
intensity-based similarity metric assumes some correspondence between the two
images' intensities, and a lesion that is bright in one series and absent in the
other violates that assumption locally. The failure mode is not a crash: it is a
plausible-looking deformation that pulls tissue in to cover the missing uptake,
which is exactly the kind of wrong answer this project cares most about.

    ORTHOGONAL DESIGN — content x transform x background, 18 series

      content    t20     20 lesions                       (baseline)
                 t25     25 lesions; the same 20 positions with *different
                         sizes*, plus 5 new ones           (progression)
                 t00     the same 25 positions, faded to just above background
                                                           (response)

      transform  id      identity     — the truth is "do not move"
                 rigid   known rigid  — repositioning between visits
                 deform  known rigid + analytic deformation

      background tex     band-limited cloud + organ uptake (liver, kidneys,
                         bladder, spine)
                 smooth  the same body with **all** structure removed

Why the design is factorial rather than the three series first sketched: with
only "three phantoms that differ in lesion content" there is no known transform,
so nothing can be scored. Crossing content with transform separates two effects
that would otherwise be confounded — *how much the appearance changed* and *how
far the engine had to move* — and the identity column is not filler: "the content
changed and the engine invented a displacement anyway" is a defect that only an
identity truth can catch.

★ WHY THE `smooth` ARM EXISTS (read before judging any t00 result)

    An egg with a smooth background is very nearly a surface of revolution, and
    inside a region of constant intensity a displacement is *unobservable* — the
    image is identical however far it slides. GNBP-2R already measured this: its
    displacement RMSE could not reach the design target because the phantom's
    interior is piecewise constant, and the shortfall was the phantom's, not the
    engine's. If the lesions are the only structure, then `t00` (lesions gone)
    removes the last thing that could be measured, and a "failure" there would
    say nothing about the engine.

    So the background is crossed as a second factor. `tex` keeps a cue after the
    lesions vanish; `smooth` deliberately keeps none. The pair brackets the
    answer: `tex` measures the engine, `smooth` measures the floor. Reporting a
    `t00` number without saying which arm it came from is meaningless.

★ NOTHING IN THE FIELD OF VIEW IS EXACTLY ZERO

    Outside the body sits a low, noisy floor (`AIR_FRACTION` of the body
    background), because reconstructed SPECT is never black outside the patient —
    scatter, septal penetration and the reconstruction itself see to that. A zero
    exterior would hand a registration a perfectly sharp, perfectly noise-free
    body silhouette, which no real acquisition offers and which is a strong
    enough cue to carry an alignment on its own.

★ THE NOISE SEED DIFFERS BETWEEN EVERY SERIES, ON PURPOSE

    Reusing one seed would give the two series *identical* noise, and a
    similarity metric — MIND-SSC especially, which is built from local
    self-similarity — can lock onto matching noise texture. The phantom would
    then be solved by an artefact that no real pair of acquisitions has, and it
    would look like excellent accuracy.

DIRECTION CONVENTION — identical to GNBP-2R, and to what GRAPHY consumes:
anatomy at fixed-space point ``p`` sits at ``q = T(p)`` in the moving series.
``T`` is what a registration must recover and what is published here. Generating
the moving volume uses ``T^-1``; that inverse is machinery, not truth.

Scoring reuses ``score_registration.mjs`` unchanged — the ground-truth key names
and the closed-form deformation match what that scorer already evaluates:

    node score_registration.mjs --truth ./phantom/GNBP-5N_ground_truth.json \
         --series t25-rigid-tex --estimate '{"matrix_4x4_row_major":[...]}'

Usage:
    python3 make_phantom_5n.py --out ./phantom
    python3 make_phantom_5n.py --out ./phantom --series t20-id-tex --force
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys

import numpy as np

from dicom_io import series_checksum, write_nm_tomo

PHANTOM_ID = "GNBP-5N"
PHANTOM_VERSION = "1.0"

# ── Geometry of the written series ───────────────────────────────────────────
# A 128 matrix at 4.42 mm is the classic reconstructed-SPECT grid (565 mm FOV),
# and the coarseness is part of what is being tested: at this voxel size a 10 mm
# lesion is barely two voxels across, so partial-volume loss is real rather than
# simulated. 96 slices covers the 380 mm tall body with room to spare.
ROWS = COLUMNS = 128
N_SLICES = 96
PIXEL_SPACING = (4.42, 4.42)
SLICE_THICKNESS = 4.42

# The activity map is evaluated on a grid this many times finer per axis, blurred
# with the pre-reconstruction PSF, and only then binned down to the output grid.
# Doing it in that order is what makes partial-volume loss *emerge* from the
# physics instead of being applied as a correction factor afterwards.
FINE = 2

# ── Body: an egg ─────────────────────────────────────────────────────────────
# Semi-axes in mm about the origin, LPS. The cross-section is elliptical rather
# than circular (a torso is wider than it is deep) and the taper makes the widest
# cross-section sit above the centre. Both matter for observability: a circular,
# fore-aft symmetric ovoid is a surface of revolution, and rotation about its
# axis leaves the image unchanged — the engine would be asked to recover
# something the data cannot express.
EGG_SEMI_AXES_MM = (150.0, 105.0, 190.0)
EGG_TAPER = 0.18  # cross-section scale = 1 + taper * (z / c)

BODY_BASE = 100.0  # background activity, arbitrary units
BODY_FALLOFF = 0.25  # uptake falls this fraction from centre to surface

# ── Background structure (the `tex` arm only) ────────────────────────────────
# A random Fourier series rather than a sampled noise volume. The reason is the
# same one that made GNBP-2R's deformation a closed form: the moving series must
# be evaluated at arbitrary warped coordinates, and a field stored on a grid
# could only be evaluated there by interpolating it — which would fold
# interpolation error into the data and make the "truth" a truth about an
# interpolation. A sum of sinusoids evaluates exactly, anywhere, from a seed.
CLOUD_TERMS = 48
CLOUD_SEED = 20260820
CLOUD_WAVELENGTH_MM = (50.0, 150.0)
CLOUD_RELATIVE_AMPLITUDE = 0.30

# Organ uptake, as (name, centre_mm, semi_axes_mm, multiplier). LPS: +x is the
# patient's left, +y posterior, +z head. Values are plausible for a 177Lu
# therapy scan (kidneys and bladder dominate, liver moderate).
ORGANS = (
    ("liver", (-55.0, -18.0, 62.0), (80.0, 55.0, 55.0), 1.9),
    ("kidney_left", (72.0, 46.0, 8.0), (26.0, 18.0, 32.0), 2.6),
    ("kidney_right", (-72.0, 46.0, 8.0), (26.0, 18.0, 32.0), 2.6),
    ("bladder", (0.0, -22.0, -138.0), (30.0, 26.0, 28.0), 5.0),
    ("spine", (0.0, 66.0, 0.0), (15.0, 15.0, 170.0), 1.5),
)

# ── Lesions ──────────────────────────────────────────────────────────────────
LESION_SEED = 20260821
N_COMMON = 20  # present in t20 and t25 at the same positions
N_NEW = 5  # appear only in t25 (and stay, faded, in t00)
LESION_DIAMETER_RANGE_MM = (9.0, 42.0)
LESION_CONTRAST_RANGE = (3.0, 12.0)  # lesion uptake / local background
# t25 rescales every common lesion by a factor in this range: some grow, some
# shrink. A follow-up where every lesion moves the same way would let an engine
# succeed by modelling one global change.
LESION_SIZE_CHANGE_RANGE = (0.55, 1.85)
# t00: what is left after a complete response. Not zero — a real responder keeps
# a trace of uptake, and zeroing it would additionally remove the *shape* of the
# lesion bed, which is a bigger change than the clinical case.
LESION_RESIDUAL_CONTRAST_RANGE = (1.05, 1.20)

# ── SPECT physics ────────────────────────────────────────────────────────────
# Total effective resolution is sqrt(8^2 + 6^2) ~= 10 mm FWHM, which is where a
# 177Lu SPECT with a medium-energy collimator lands. The split matters: blurring
# before the Poisson draw is the collimator and the iterative reconstruction,
# blurring after it is the reconstruction post-filter, and only that order gives
# the *correlated* noise a real reconstruction has. White voxel noise is much
# easier for a similarity metric than correlated noise of the same variance.
PSF_PRE_FWHM_MM = 8.0
PSF_POST_FWHM_MM = 6.0
# COUNT_SCALE is set from the *measured* background CV rather than from an
# activity-and-duration calculation, because what matters to a similarity metric
# is the noise it actually sees. 0.10 puts the post-filtered background CV near
# 12 %, which is where a clinical 177Lu SPECT sits. It was 0.30 in the first
# draft, giving 6.7 % — visibly cleaner than any real acquisition, and a phantom
# that is quietly easier than reality is the kind that certifies an engine which
# then fails on patients.
COUNT_SCALE = 0.10  # counts per activity unit; lower = noisier

# Activity outside the body, as a fraction of BODY_BASE. Reconstructed SPECT is
# never black outside the patient: scatter, collimator septal penetration and the
# iterative reconstruction itself all put a low, noisy floor across the field of
# view. Leaving it at exactly zero would hand a registration something no real
# acquisition offers — a perfectly sharp, perfectly noise-free body silhouette,
# which is a strong enough cue to carry an alignment on its own. The halo that
# hugs the body comes free from the pre-PSF blur; this constant is the far-field
# floor underneath it.
AIR_FRACTION = 0.04

# ★ The stored value is NOT the raw count.
#
# The Poisson draw happens at a realistic count level (~10 counts per voxel in
# the body, which is what sets the noise), but the post-filter output is a
# *fractional* image and a reconstruction stores it scaled to use the available
# range. Rounding it to integer counts instead — which is what this generator did
# first — quantised the whole body to about 16 grey levels: `t00-id-smooth` held
# exactly 16 distinct values in the entire volume. That is not a cosmetic issue.
# Mattes MI bins intensities (48 bins by default) and MIND-SSC builds descriptors
# from small intensity differences; against a 16-level image both are measuring
# an artefact of the rounding rather than the anatomy, and the air floor added
# above would have collapsed to a sparse 0/1 speckle instead of noise.
#
# 200 keeps the brightest voxel measured across the 18 series (202 counts) at
# ~40k, comfortably inside uint16. The writer refuses anything over 65535 rather
# than wrapping, so a violation fails loudly.
STORE_SCALE = 200

# ── Transforms ───────────────────────────────────────────────────────────────
# Larger than GNBP-2R's on purpose: that phantom models the residual misalignment
# of a hybrid scanner's simultaneous acquisition, this one models a patient
# repositioned on a different day, months apart.
CENTRE_MM = np.zeros(3)

RIGID_TRANSLATION_MM = (12.4, -8.7, 21.3)
RIGID_EULER_DEG = (4.6, -3.1, 7.8)

DEFORM_TRANSLATION_MM = (5.8, -4.2, 9.6)
DEFORM_EULER_DEG = (2.4, -1.6, 3.9)
# Same closed form as GNBP-2R (score_registration.mjs already evaluates it), with
# a wavelength scaled to a torso rather than a head.
#   u_x = Ax sin(k y) cos(k z);  u_y = Ay sin(k z) cos(k x);  u_z = Az sin(k x) cos(k y)
DEFORM_WAVELENGTH_MM = 340.0
DEFORM_AMPLITUDE_MM = (13.0, 9.0, 17.0)

CONTENTS = ("t20", "t25", "t00")
TRANSFORMS = ("id", "rigid", "deform")
TEXTURES = ("tex", "smooth")


# ══ Transform model ══════════════════════════════════════════════════════════
# Copied from make_phantom_2r.py rather than imported: the two generators are
# independently runnable artefacts and a phantom that silently changed because a
# sibling was edited would be worse than a duplicated function. Both must match
# `mat4FromEulerDeg` in frontend/src/viewer/regTransform.ts — that agreement is
# the whole point of publishing rotation parameters.


def euler_matrix(rx_deg: float, ry_deg: float, rz_deg: float) -> np.ndarray:
    """R = Rz . Ry . Rx, degrees, right-handed about the LPS axes."""
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


def deform_displacement(p: np.ndarray) -> np.ndarray:
    """u(p) for the analytic deformation. `p` is (..., 3) in mm."""
    k = 2.0 * np.pi / DEFORM_WAVELENGTH_MM
    ax, ay, az = DEFORM_AMPLITUDE_MM
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    u = np.empty_like(p)
    u[..., 0] = ax * np.sin(k * y) * np.cos(k * z)
    u[..., 1] = ay * np.sin(k * z) * np.cos(k * x)
    u[..., 2] = az * np.sin(k * x) * np.cos(k * y)
    return u


def deform_jacobian_det(p: np.ndarray) -> np.ndarray:
    """det(I + du/dp), in closed form."""
    k = 2.0 * np.pi / DEFORM_WAVELENGTH_MM
    ax, ay, az = DEFORM_AMPLITUDE_MM
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    dxy = ax * k * np.cos(k * y) * np.cos(k * z)
    dxz = -ax * k * np.sin(k * y) * np.sin(k * z)
    dyz = ay * k * np.cos(k * z) * np.cos(k * x)
    dyx = -ay * k * np.sin(k * z) * np.sin(k * x)
    dzx = az * k * np.cos(k * x) * np.cos(k * y)
    dzy = -az * k * np.sin(k * x) * np.sin(k * y)
    return 1.0 * (1.0 - dyz * dzy) - dxy * (dyx - dyz * dzx) + dxz * (dyx * dzy - dzx)


class Warp:
    """Forward transform T (fixed -> moving) plus the inverse used to generate."""

    def __init__(self, name: str, matrix: np.ndarray, deformable: bool = False):
        self.name = name
        self.matrix = matrix
        self.inv_matrix = np.linalg.inv(matrix)
        self.deformable = deformable

    def forward(self, p: np.ndarray) -> np.ndarray:
        q = p @ self.matrix[:3, :3].T + self.matrix[:3, 3]
        if self.deformable:
            q = q + deform_displacement(q)
        return q

    def inverse(self, q: np.ndarray, tol_mm: float = 1e-9, max_iters: int = 60) -> np.ndarray:
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
    deform = affine_forward(euler_matrix(*DEFORM_EULER_DEG), np.asarray(DEFORM_TRANSLATION_MM))
    return {
        "id": Warp("id", np.eye(4)),
        "rigid": Warp("rigid", rigid),
        "deform": Warp("deform", deform, deformable=True),
    }


# ══ Content ══════════════════════════════════════════════════════════════════


def _cloud_terms() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Frequencies, phases and amplitudes of the background cloud.

    Directions are drawn uniformly on the sphere and wavelengths log-uniformly in
    `CLOUD_WAVELENGTH_MM`, so the field is isotropic and band-limited. The 1/sqrt
    normalisation makes the sum approximately unit-variance regardless of how
    many terms are used, which keeps `CLOUD_RELATIVE_AMPLITUDE` meaning the same
    thing if the term count is ever changed.
    """
    rng = np.random.default_rng(CLOUD_SEED)
    # Uniform on the sphere: z uniform in [-1,1], azimuth uniform.
    cos_theta = rng.uniform(-1.0, 1.0, CLOUD_TERMS)
    sin_theta = np.sqrt(1.0 - cos_theta**2)
    phi = rng.uniform(0.0, 2.0 * np.pi, CLOUD_TERMS)
    direction = np.stack(
        [sin_theta * np.cos(phi), sin_theta * np.sin(phi), cos_theta], axis=-1
    )
    lo, hi = CLOUD_WAVELENGTH_MM
    wavelength = np.exp(rng.uniform(np.log(lo), np.log(hi), CLOUD_TERMS))
    k = direction * (2.0 * np.pi / wavelength)[:, None]
    phase = rng.uniform(0.0, 2.0 * np.pi, CLOUD_TERMS)
    amplitude = np.full(CLOUD_TERMS, np.sqrt(2.0 / CLOUD_TERMS))
    return k, phase, amplitude


CLOUD_K, CLOUD_PHASE, CLOUD_AMPLITUDE = _cloud_terms()


def cloud_at(p: np.ndarray) -> np.ndarray:
    """Zero-mean, ~unit-variance band-limited field at points `p` (..., 3)."""
    out = np.zeros(p.shape[:-1], dtype=np.float64)
    for i in range(CLOUD_TERMS):
        arg = p[..., 0] * CLOUD_K[i, 0] + p[..., 1] * CLOUD_K[i, 1] + p[..., 2] * CLOUD_K[i, 2]
        out += CLOUD_AMPLITUDE[i] * np.sin(arg + CLOUD_PHASE[i])
    return out


def _lesion_table() -> list[dict]:
    """The 25 lesion sites, with their size and contrast in each content variant.

    Positions are rejection-sampled inside the egg with a margin, and kept apart
    so that no two lesions merge after the 10 mm blur — overlapping lesions would
    make "did the engine find lesion 7?" unanswerable. Sizes span from below the
    system resolution to well above it, because how a metric copes with an
    appearing lesion depends strongly on whether the lesion is resolved at all.
    """
    rng = np.random.default_rng(LESION_SEED)
    a, b, c = EGG_SEMI_AXES_MM
    d_lo, d_hi = LESION_DIAMETER_RANGE_MM
    k_lo, k_hi = LESION_CONTRAST_RANGE

    total = N_COMMON + N_NEW
    centres: list[np.ndarray] = []
    radii: list[float] = []
    attempts = 0
    while len(centres) < total:
        attempts += 1
        if attempts > 200_000:
            raise SystemExit("could not place lesions; loosen the spacing rule")
        d = float(rng.uniform(d_lo, d_hi))
        r = d / 2.0
        p = np.array(
            [
                rng.uniform(-a, a),
                rng.uniform(-b, b),
                rng.uniform(-c, c),
            ]
        )
        zt = p[2] / c
        w = 1.0 + EGG_TAPER * zt
        # Keep the whole lesion, plus a blur radius, inside the body: a lesion
        # clipped by the surface has no defined size and its centre is no longer
        # a landmark whose expected reading is known.
        margin = r + PSF_PRE_FWHM_MM
        if w <= 0:
            continue
        rho2 = (p[0] / (a * w - margin)) ** 2 + (p[1] / (b * w - margin)) ** 2 + (
            p[2] / (c - margin)
        ) ** 2
        if not np.isfinite(rho2) or rho2 > 1.0:
            continue
        ok = True
        for q, rq in zip(centres, radii):
            if np.linalg.norm(p - q) < r + rq + 2.0 * PSF_PRE_FWHM_MM:
                ok = False
                break
        if not ok:
            continue
        centres.append(p)
        radii.append(r)

    table = []
    for i in range(total):
        common = i < N_COMMON
        d1 = 2.0 * radii[i]
        k1 = float(rng.uniform(k_lo, k_hi))
        d2 = d1 * float(rng.uniform(*LESION_SIZE_CHANGE_RANGE))
        k2 = float(rng.uniform(k_lo, k_hi))
        k0 = float(rng.uniform(*LESION_RESIDUAL_CONTRAST_RANGE))
        table.append(
            {
                "id": f"L{i + 1:02d}",
                "centre_mm": [float(v) for v in centres[i]],
                "common": bool(common),
                # diameter / contrast per content variant; None = absent
                "t20": {"diameter_mm": d1, "contrast": k1} if common else None,
                "t25": {"diameter_mm": d2, "contrast": k2},
                "t00": {"diameter_mm": d2, "contrast": k0},
            }
        )
    return table


LESIONS = _lesion_table()


def activity_at(
    p: np.ndarray, content: str, textured: bool, *, include_lesions: bool = True
) -> np.ndarray:
    """Activity concentration at fixed-space points `p` (..., 3), arbitrary units.

    Everything here is analytic, which is what lets the moving series be
    generated by evaluating at ``T^-1(q)`` instead of interpolating the fixed
    series. An interpolated moving series would make the published truth a truth
    about the interpolator.
    """
    a, b, c = EGG_SEMI_AXES_MM
    x, y, z = p[..., 0], p[..., 1], p[..., 2]

    zt = z / c
    w = 1.0 + EGG_TAPER * zt
    safe_w = np.where(w > 1e-3, w, 1e-3)
    rho2 = (x / (a * safe_w)) ** 2 + (y / (b * safe_w)) ** 2 + zt**2
    inside = (rho2 <= 1.0) & (w > 0.0)

    out = np.zeros(p.shape[:-1], dtype=np.float64)
    base = BODY_BASE * (1.0 - BODY_FALLOFF * np.clip(rho2, 0.0, 1.0))

    if textured:
        base = base * (1.0 + CLOUD_RELATIVE_AMPLITUDE * cloud_at(p))
        for _name, centre, semi, mult in ORGANS:
            u = (x - centre[0]) / semi[0]
            v = (y - centre[1]) / semi[1]
            t = (z - centre[2]) / semi[2]
            in_organ = (u * u + v * v + t * t) <= 1.0
            base = np.where(in_organ, base * mult, base)

    base = np.maximum(base, 0.0)
    out = np.where(inside, base, BODY_BASE * AIR_FRACTION)

    # Lesions add (contrast - 1) x the local background, so "contrast" means the
    # ratio a reader would measure, independent of where the lesion sits.
    if not include_lesions:
        return out

    h = PIXEL_SPACING[0] / FINE  # fine-voxel size, for the partial-volume ramp
    for les in LESIONS:
        spec = les[content]
        if spec is None:
            continue
        centre = np.asarray(les["centre_mm"])
        r = spec["diameter_mm"] / 2.0
        dist = np.sqrt(
            (x - centre[0]) ** 2 + (y - centre[1]) ** 2 + (z - centre[2]) ** 2
        )
        # Linear ramp across one fine voxel rather than a binary in/out test. A
        # 9 mm lesion is four fine voxels across, and a binary test would put a
        # 10-20 % error on its integrated activity purely from where the sphere
        # happened to fall relative to the sample points — an error that would be
        # read later as partial-volume physics.
        frac = np.clip((r - dist) / h + 0.5, 0.0, 1.0)
        out = out + np.where(inside, frac * (spec["contrast"] - 1.0) * base, 0.0)

    return out


# ══ Acquisition simulation ═══════════════════════════════════════════════════


def _gaussian_blur(vol: np.ndarray, sigma_vox: tuple[float, float, float]) -> np.ndarray:
    """Separable Gaussian blur in float32.

    Written out rather than pulled from scipy: the bench generators depend only
    on numpy and pydicom, and adding a dependency for one convolution would make
    the phantom harder to reproduce, not easier.
    """
    out = vol.astype(np.float32)
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
            acc += np.float32(wgt) * padded[tuple(sl)]
        out = acc
    return out


def _fwhm_to_sigma(fwhm: float) -> float:
    return fwhm / (2.0 * np.sqrt(2.0 * np.log(2.0)))


def _grid_centres(n: int, spacing: float) -> np.ndarray:
    """Voxel-centre coordinates of an axis, centred on 0 — matching the writer."""
    return (np.arange(n) - (n - 1) / 2.0) * spacing


def build_activity_fine(warp: Warp, content: str, textured: bool) -> np.ndarray:
    """Activity on the fine grid, shape (N_SLICES*FINE, ROWS*FINE, COLUMNS*FINE)."""
    fx = COLUMNS * FINE
    fy = ROWS * FINE
    fz = N_SLICES * FINE
    sx = PIXEL_SPACING[0] / FINE
    sy = PIXEL_SPACING[1] / FINE
    sz = SLICE_THICKNESS / FINE

    x_c = _grid_centres(fx, sx)
    y_c = _grid_centres(fy, sy)
    z_c = _grid_centres(fz, sz)

    XX, YY = np.meshgrid(x_c, y_c)  # (fy, fx)
    pts = np.empty(XX.shape + (3,), dtype=np.float64)
    pts[..., 0] = XX
    pts[..., 1] = YY

    vol = np.empty((fz, fy, fx), dtype=np.float32)
    for k in range(fz):
        pts[..., 2] = z_c[k]
        # The moving voxel at `pts` holds the fixed content at T^-1(pts).
        src = warp.inverse(pts)
        vol[k] = activity_at(src, content, textured).astype(np.float32)
    return vol


def _bin_down(fine: np.ndarray) -> np.ndarray:
    """Average FINE^3 fine voxels into each output voxel."""
    fz, fy, fx = fine.shape
    return fine.reshape(
        fz // FINE, FINE, fy // FINE, FINE, fx // FINE, FINE
    ).mean(axis=(1, 3, 5))


def simulate_acquisition(
    activity_fine: np.ndarray, noise_seed: int
) -> tuple[np.ndarray, np.ndarray]:
    """Activity -> counts: PSF, binning, Poisson, post-filter.

    Returns ``(counts, expected)`` — the written volume and the same pipeline run
    without the Poisson draw. `expected` is not written anywhere; it exists so
    that the structure in the image and the noise on top of it can be reported as
    two separate numbers. Measuring them together gives one figure that moves
    when either changes, which is exactly the figure that cannot answer "did the
    `smooth` arm really lose its structure?".

    The order is the physical one and it is not interchangeable. Blurring after
    binning would apply the collimator response at the wrong resolution and small
    lesions would keep an activity they cannot have; drawing Poisson counts
    before the blur would leave the noise white, which is markedly easier for a
    similarity metric than the correlated noise a reconstruction produces.
    """
    fine_spacing = (SLICE_THICKNESS / FINE, PIXEL_SPACING[1] / FINE, PIXEL_SPACING[0] / FINE)
    sigma_pre = _fwhm_to_sigma(PSF_PRE_FWHM_MM)
    blurred = _gaussian_blur(activity_fine, tuple(sigma_pre / s for s in fine_spacing))

    coarse = np.clip(_bin_down(blurred), 0.0, None) * COUNT_SCALE

    rng = np.random.default_rng(noise_seed)
    counts = rng.poisson(coarse).astype(np.float32)

    coarse_spacing = (SLICE_THICKNESS, PIXEL_SPACING[1], PIXEL_SPACING[0])
    sigma_post = _fwhm_to_sigma(PSF_POST_FWHM_MM)
    sigma_vox = tuple(sigma_post / s for s in coarse_spacing)
    filtered = _gaussian_blur(counts, sigma_vox) * STORE_SCALE
    expected = _gaussian_blur(coarse.astype(np.float32), sigma_vox) * STORE_SCALE

    rounded = np.rint(filtered)
    if rounded.max() > 65535 or rounded.min() < 0:
        raise SystemExit(
            f"counts leave the encodable range [0, 65535] "
            f"(got {rounded.min():.0f}..{rounded.max():.0f}); lower COUNT_SCALE"
        )
    return rounded.astype(np.uint16), expected


# ══ Ground truth and self-check ══════════════════════════════════════════════


def landmarks(warp: Warp, content: str) -> list[dict]:
    """Lesion centres in both spaces — the TRE landmarks.

    ★ Every one of the 25 sites is published for every content variant, including
    the ones that are absent or faded. A landmark's *position* is known whether
    or not anything is visible there, and "how far off is the engine where the
    lesion used to be?" is precisely the question this phantom exists to ask.
    Restricting the landmark set to what is visible would quietly turn the hard
    case into the easy one.
    """
    out = []
    for les in LESIONS:
        p = np.asarray(les["centre_mm"])
        spec = les[content]
        out.append(
            {
                "name": les["id"],
                "fixed_mm": [float(v) for v in p],
                "moving_mm": [float(v) for v in warp.forward(p[None, :])[0]],
                "visible": spec is not None and spec["contrast"] > 1.5,
            }
        )
    return out


def displacement_summary(warp: Warp) -> dict:
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
        if det.min() <= 0:
            raise SystemExit("deformation folds (min |J| <= 0); reduce DEFORM_AMPLITUDE_MM")
        resid = np.linalg.norm(warp.forward(warp.inverse(grid)) - grid, axis=-1)
        summary["inverse_residual_mm_max"] = float(resid.max())
    return summary


def sample_trilinear(volume: np.ndarray, q: np.ndarray) -> float:
    """Value of `volume` at world point `q`, interpolated.

    ★ Not "the value of the nearest voxel". At 4.42 mm a lesion centre can sit
    3.8 mm from the nearest voxel centre, and on a peak that is only a couple of
    voxels wide that miss reads as a collapse of the lesion's contrast. The first
    version of this file did snap to the nearest voxel and reported an 11.6 mm
    lesion at 1.5x background when the partial-volume physics says ~4.8x — a
    measurement artefact that, left in the published truth, would have been read
    later as "small lesions are invisible in this phantom".
    """
    nz, ny, nx = volume.shape
    fx = q[0] / PIXEL_SPACING[0] + (nx - 1) / 2.0
    fy = q[1] / PIXEL_SPACING[1] + (ny - 1) / 2.0
    fz = q[2] / SLICE_THICKNESS + (nz - 1) / 2.0
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


def measure_lesions(
    volume: np.ndarray, warp: Warp, content: str, textured: bool
) -> list[dict]:
    """Measure each lesion in the written volume, at its predicted moving position.

    Two jobs at once.

    1. **Direction check.** If `moving_mm` had been computed with ``T^-1`` by
       mistake, a bright lesion would be looked for where there is only
       background and the contrast would come out at ~1. That is the failure
       GNBP-2R's self-check catches with HU, and it is caught here with counts.

    2. **Observability.** The contrast-to-noise ratio says which lesions are
       actually detectable after a 10 mm blur and Poisson statistics. A 9 mm
       lesion at 3:1 does not survive, and publishing its CNR keeps anyone from
       reading a large TRE at that landmark as an engine defect. This is the
       measurement the project has repeatedly wished it had made first.
    """
    x_c = _grid_centres(COLUMNS, PIXEL_SPACING[0])
    y_c = _grid_centres(ROWS, PIXEL_SPACING[1])
    z_c = _grid_centres(N_SLICES, SLICE_THICKNESS)
    vol = volume.astype(np.float64)

    ZZ, YY, XX = np.meshgrid(z_c, y_c, x_c, indexing="ij")

    out = []
    for les in LESIONS:
        spec = les[content]
        centre = np.asarray(les["centre_mm"])
        q = warp.forward(centre[None, :])[0]
        dist = np.sqrt((XX - q[0]) ** 2 + (YY - q[1]) ** 2 + (ZZ - q[2]) ** 2)

        r = (spec["diameter_mm"] / 2.0) if spec else 6.0
        eff = float(np.hypot(PSF_PRE_FWHM_MM, PSF_POST_FWHM_MM))
        # Background shell clear of the blurred lesion edge, and thin enough that
        # it samples the neighbourhood rather than half the body.
        shell = (dist > r + eff) & (dist <= r + eff + 15.0)
        if shell.sum() < 20:
            continue
        peak = sample_trilinear(volume, q)
        core = dist <= r
        shell_mean = float(vol[shell].mean())
        shell_sd = float(vol[shell].std())
        # ★ Contrast is quoted against the *analytic local background at the
        #   lesion centre*, which is what `nominal_contrast` was defined against.
        #   Quoting it against the shell mean instead — as the first draft did —
        #   made structured regions look wrong in both directions: a lesion in a
        #   low pocket of the cloud read 12.4x when 6.8x was put in, and one
        #   beside a kidney read 1.7x when 3.1x was put in. Neither was a defect
        #   in the data; both were the reference moving under the measurement.
        local_bg = COUNT_SCALE * STORE_SCALE * float(
            activity_at(centre[None, :], content, textured, include_lesions=False)[0]
        )
        out.append(
            {
                "id": les["id"],
                "present": spec is not None,
                "diameter_mm": float(spec["diameter_mm"]) if spec else None,
                "nominal_contrast": float(spec["contrast"]) if spec else None,
                "moving_mm": [float(v) for v in q],
                "local_background_counts": local_bg,
                # Peak: interpolated at the exact centre — what survives the PSF.
                "peak_contrast": peak / local_bg if local_bg > 0 else None,
                # Mean over the nominal lesion volume — what a VOI would read,
                # necessarily lower because the VOI edge is already background.
                "mean_contrast": (float(vol[core].mean()) / local_bg)
                if (core.sum() > 0 and local_bg > 0)
                else None,
                # Fraction of the nominal contrast excess that survived the PSF.
                # ~1 for lesions well above the 10 mm resolution, falling steeply
                # below it. This is the number that says whether partial-volume
                # loss is behaving, and it is checkable against theory.
                "recovery_coefficient": (
                    ((peak / local_bg) - 1.0) / (spec["contrast"] - 1.0)
                    if (spec and local_bg > 0 and spec["contrast"] > 1.0)
                    else None
                ),
                # Detectability against the *structured* background, not against
                # noise alone: the shell SD includes the cloud and any organ edge,
                # which is what a reader actually has to see past.
                "shell_background_counts": shell_mean,
                "cnr": (peak - shell_mean) / shell_sd if shell_sd > 0 else None,
            }
        )
    return out


# Only lesions that are big and bright enough to survive the blur are asserted.
# Asserting on a 9 mm 3:1 lesion would make the generator fail for a reason that
# is physics rather than a bug, and a self-check that cries wolf gets disabled.
ASSERT_MIN_DIAMETER_MM = 25.0
ASSERT_MIN_CONTRAST = 6.0
ASSERT_MIN_MEASURED_CONTRAST = 1.25


def self_check(measured: list[dict], content: str) -> None:
    if content == "t00":
        return  # nothing is meant to be visible; there is no direction claim to test
    failures = []
    checked = 0
    for m in measured:
        if not m["present"]:
            continue
        if m["diameter_mm"] < ASSERT_MIN_DIAMETER_MM or m["nominal_contrast"] < ASSERT_MIN_CONTRAST:
            continue
        checked += 1
        if (m["peak_contrast"] or 0.0) < ASSERT_MIN_MEASURED_CONTRAST:
            failures.append(
                f"{m['id']}: d={m['diameter_mm']:.0f}mm k={m['nominal_contrast']:.1f} "
                f"reads {m['peak_contrast']:.2f}x background"
            )
    if checked == 0:
        raise SystemExit(
            "generator self-check vacuous: no lesion was large and bright enough to assert on. "
            "Either the lesion table or the thresholds are wrong — a check that tests nothing "
            "is worse than no check, because it reports success."
        )
    if failures:
        raise SystemExit(
            "generator self-check failed — a lesion is not where the truth says it is, which "
            "usually means the fixed->moving direction is inverted:\n  " + "\n  ".join(failures)
        )


def background_stats(volume: np.ndarray, expected: np.ndarray, warp: Warp) -> dict:
    """Counts inside the body, away from any lesion: the noise and structure floor.

    `structure_cv` is what the `tex` / `smooth` arms are supposed to differ in,
    so it is measured rather than asserted from the configuration — if the cloud
    were ever switched off by accident, the two arms would silently become the
    same experiment.
    """
    x_c = _grid_centres(COLUMNS, PIXEL_SPACING[0])
    y_c = _grid_centres(ROWS, PIXEL_SPACING[1])
    z_c = _grid_centres(N_SLICES, SLICE_THICKNESS)
    ZZ, YY, XX = np.meshgrid(z_c, y_c, x_c, indexing="ij")
    pts = np.stack([XX, YY, ZZ], axis=-1)

    src = warp.inverse(pts.reshape(-1, 3)).reshape(pts.shape)
    a, b, c = EGG_SEMI_AXES_MM
    zt = src[..., 2] / c
    w = 1.0 + EGG_TAPER * zt
    safe_w = np.where(w > 1e-3, w, 1e-3)
    rho2 = (src[..., 0] / (a * safe_w)) ** 2 + (src[..., 1] / (b * safe_w)) ** 2 + zt**2
    # Well inside the body, so the surface roll-off does not count as structure.
    body = (rho2 <= 0.7) & (w > 0.0)

    for les in LESIONS:
        centre = np.asarray(les["centre_mm"])
        d = np.linalg.norm(src - centre, axis=-1)
        body &= d > (les["t25"]["diameter_mm"] / 2.0 + 2.0 * PSF_PRE_FWHM_MM)

    vals = volume.astype(np.float64)[body]
    exp = expected.astype(np.float64)[body]
    if vals.size < 1000:
        return {"voxels": int(vals.size)}
    mean = float(exp.mean())
    return {
        "voxels": int(vals.size),
        # Reported in counts, not stored units: the count level is the physically
        # meaningful quantity (it is what sets the Poisson noise), while
        # STORE_SCALE is a container detail. The CVs below are ratios and so are
        # unaffected by the scaling either way.
        "mean_counts": mean / STORE_SCALE,
        # Anatomy only — the cloud and the organs. This is the number the `tex`
        # and `smooth` arms must differ in, and measuring it (rather than trusting
        # CLOUD_RELATIVE_AMPLITUDE) is what would catch the cloud being switched
        # off by accident, which would silently make the two arms one experiment.
        "structure_cv": float(exp.std() / mean) if mean > 0 else None,
        # Counting statistics only, after the post-filter correlated them.
        "noise_cv": float((vals - exp).std() / mean) if mean > 0 else None,
        "total_cv": float(vals.std() / mean) if mean > 0 else None,
    }


def air_statistics(volume: np.ndarray, expected: np.ndarray, warp: Warp) -> dict:
    """Counts well outside the body — the floor that used to be exactly zero.

    Measured rather than asserted from AIR_FRACTION, for the same reason the
    background structure is measured: a constant that silently stops taking
    effect leaves a phantom that looks configured and is not. `noise_cv` here is
    high by construction — a few tenths of a count per voxel is a noisy place —
    and that is the point: the body outline is no longer a noise-free edge.
    """
    x_c = _grid_centres(COLUMNS, PIXEL_SPACING[0])
    y_c = _grid_centres(ROWS, PIXEL_SPACING[1])
    z_c = _grid_centres(N_SLICES, SLICE_THICKNESS)
    ZZ, YY, XX = np.meshgrid(z_c, y_c, x_c, indexing="ij")
    pts = np.stack([XX, YY, ZZ], axis=-1)

    src = warp.inverse(pts.reshape(-1, 3)).reshape(pts.shape)
    a, b, c = EGG_SEMI_AXES_MM
    zt = src[..., 2] / c
    w = 1.0 + EGG_TAPER * zt
    safe_w = np.where(w > 1e-3, w, 1e-3)
    rho2 = (src[..., 0] / (a * safe_w)) ** 2 + (src[..., 1] / (b * safe_w)) ** 2 + zt**2
    # Clear of the body *and* of the PSF halo that hugs it, so what is measured
    # is the far-field floor rather than spill-over from the patient.
    air = (rho2 > 1.6) | (w <= 0.0)

    vals = volume.astype(np.float64)[air]
    exp = expected.astype(np.float64)[air]
    if vals.size < 1000:
        return {"voxels": int(vals.size)}
    mean = float(exp.mean())
    return {
        "voxels": int(vals.size),
        "mean_counts": mean / STORE_SCALE,
        "noise_cv": float((vals - exp).std() / mean) if mean > 0 else None,
        "fraction_of_body_background": AIR_FRACTION,
    }


# ══ Series table ═════════════════════════════════════════════════════════════

CONTENT_NOTE = {
    "t20": f"{N_COMMON} lesions (baseline)",
    "t25": f"{N_COMMON + N_NEW} lesions: the {N_COMMON} baseline sites resized, plus {N_NEW} new",
    "t00": "the same 25 sites, faded to just above background (response)",
}
# Short forms for SeriesDescription. VR LO allows 64 characters and the long
# notes above overrun it once the series id is prefixed; `dicom_io` now refuses
# such a value outright rather than letting pydicom warn and write it anyway.
CONTENT_SHORT = {
    "t20": f"{N_COMMON} lesions",
    "t25": f"{N_COMMON + N_NEW} lesions ({N_COMMON} resized + {N_NEW} new)",
    "t00": "lesions faded (response)",
}
TEXTURE_NOTE = {
    "tex": "band-limited cloud + organ uptake",
    "smooth": "no background structure at all (observability floor)",
}


def series_name(content: str, transform: str, texture: str) -> str:
    return f"{content}-{transform}-{texture}"


def all_series() -> list[tuple[str, str, str]]:
    return [(c, t, x) for x in TEXTURES for c in CONTENTS for t in TRANSFORMS]


def noise_seed_for(name: str) -> int:
    """A distinct, deterministic seed per series (see the module docstring)."""
    digest = hashlib.sha256(f"{PHANTOM_ID}|{PHANTOM_VERSION}|{name}|noise".encode()).hexdigest()
    return int(digest[:8], 16)


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--out", default="./phantom", help="output directory")
    ap.add_argument("--force", action="store_true", help="overwrite existing series")
    ap.add_argument(
        "--series",
        action="append",
        help="generate only these series, e.g. t25-rigid-tex (repeatable); default is all",
    )
    ap.add_argument(
        "--texture",
        choices=TEXTURES,
        action="append",
        help="generate only this background arm (repeatable)",
    )
    args = ap.parse_args()

    warps = build_warps()
    combos = all_series()
    if args.texture:
        combos = [c for c in combos if c[2] in args.texture]
    if args.series:
        wanted = set(args.series)
        combos = [c for c in combos if series_name(*c) in wanted]
        unknown = wanted - {series_name(*c) for c in all_series()}
        if unknown:
            raise SystemExit(f"unknown series: {', '.join(sorted(unknown))}")

    truth_series = {}
    number = {series_name(*c): i + 1 for i, c in enumerate(all_series())}

    for content, transform, texture in combos:
        name = series_name(content, transform, texture)
        series_id = f"{PHANTOM_ID}-{name}"
        out_dir = os.path.join(args.out, series_id)
        if os.path.exists(out_dir):
            if not args.force:
                print(f"skip (exists): {out_dir}", file=sys.stderr)
                continue
            shutil.rmtree(out_dir)

        warp = warps[transform]
        textured = texture == "tex"
        print(f"building {series_id}: {N_SLICES} frames, {ROWS}x{COLUMNS}", file=sys.stderr)

        fine = build_activity_fine(warp, content, textured)
        volume, expected = simulate_acquisition(fine, noise_seed_for(name))
        del fine

        write_nm_tomo(
            volume,
            out_dir,
            series_description=f"{series_id} {CONTENT_SHORT[content]}",
            patient_id=f"{PHANTOM_ID}-{texture}",
            patient_name=f"GNBP^5N^{texture}",
            pixel_spacing=PIXEL_SPACING,
            slice_thickness=SLICE_THICKNESS,
            series_number=number[name],
            uid_key=f"{series_id}-{PHANTOM_VERSION}",
            # One study per background arm. Keeping `tex` and `smooth` apart is
            # not tidiness: registering a textured series against a smooth one is
            # a comparison with no meaning, and separate studies make it awkward
            # to do by accident.
            study_key=f"{PHANTOM_ID}-{PHANTOM_VERSION}-{texture}",
            study_description=f"GRAPHY-Next longitudinal SPECT registration phantom ({texture})",
            model_name=f"{series_id} v{PHANTOM_VERSION}",
            z_origin_mm=-(N_SLICES - 1) / 2.0 * SLICE_THICKNESS,
            body_part="ABDOMEN",
            protocol_name=f"{PHANTOM_ID} longitudinal SPECT phantom",
            # ★ Every series declares its own frame of reference. Two SPECT
            #   sessions months apart do not share one, and pretending otherwise
            #   would send the engine down its "simultaneous acquisition, start
            #   from identity, restrict the search" branch — the wrong branch for
            #   this problem, and one that would flatter the identity column.
            frame_of_reference_key=f"{PHANTOM_ID}-{PHANTOM_VERSION}-{name}",
        )

        measured = measure_lesions(volume, warp, content, textured)
        self_check(measured, content)

        entry = {
            "series": series_id,
            "series_number": number[name],
            "content": content,
            "transform": transform,
            "background": texture,
            "kind": f"{transform} + content {content} + background {texture}",
            "geometry": {
                "rows": ROWS,
                "columns": COLUMNS,
                "slices": N_SLICES,
                "pixel_spacing_mm": PIXEL_SPACING[0],
                "slice_thickness_mm": SLICE_THICKNESS,
                "encoding": "single multi-frame NM instance (RECON TOMO); frames are slices",
            },
            "transform_fixed_to_moving": {
                "matrix_4x4_row_major": [float(v) for v in warp.matrix.ravel()],
                "rotation_centre_mm": [float(v) for v in CENTRE_MM],
            },
            "landmarks": landmarks(warp, content),
            "displacement": displacement_summary(warp),
            "lesion_measurements": measured,
            "background_statistics": background_stats(volume, expected, warp),
            "air_statistics": air_statistics(volume, expected, warp),
            "noise_seed": noise_seed_for(name),
            "series_md5": series_checksum(out_dir),
        }
        if transform == "rigid":
            entry["transform_fixed_to_moving"]["translation_mm"] = list(RIGID_TRANSLATION_MM)
            entry["transform_fixed_to_moving"][
                "euler_deg_rz_ry_rx_applied_as_Rz_Ry_Rx"
            ] = list(RIGID_EULER_DEG)
        if transform == "deform":
            entry["transform_fixed_to_moving"]["translation_mm"] = list(DEFORM_TRANSLATION_MM)
            entry["transform_fixed_to_moving"][
                "euler_deg_rz_ry_rx_applied_as_Rz_Ry_Rx"
            ] = list(DEFORM_EULER_DEG)
            entry["transform_fixed_to_moving"]["deformation"] = {
                "form": "u_x = Ax sin(k y) cos(k z); u_y = Ay sin(k z) cos(k x); u_z = Az sin(k x) cos(k y)",
                "applied": "after the rigid part: T(p) = M p + u(M p)",
                "k_per_mm": 2.0 * np.pi / DEFORM_WAVELENGTH_MM,
                "wavelength_mm": DEFORM_WAVELENGTH_MM,
                "amplitude_mm": list(DEFORM_AMPLITUDE_MM),
            }
        truth_series[name] = entry

        total = sum(os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir))
        bg = entry["background_statistics"]
        present = [m for m in measured if m["present"]]
        visible = sum(1 for m in present if (m.get("cnr") or 0) >= 3.0)
        print(
            f"  1 file, {total / 1024 / 1024:.1f} MiB, md5 {entry['series_md5']}",
            file=sys.stderr,
        )
        print(
            f"    background {bg.get('mean_counts', 0):.1f} counts, structure CV "
            f"{100 * (bg.get('structure_cv') or 0):.1f}% noise CV {100 * (bg.get('noise_cv') or 0):.1f}%"
            f"   lesions with CNR>=3: {visible}/{len(present)}",
            file=sys.stderr,
        )
        air = entry["air_statistics"]
        print(
            f"    air {air.get('mean_counts', 0):.2f} counts, noise CV "
            f"{100 * (air.get('noise_cv') or 0):.0f}%   stored max {int(volume.max())}",
            file=sys.stderr,
        )

    truth_path = os.path.join(args.out, f"{PHANTOM_ID}_ground_truth.json")
    existing = {}
    if os.path.exists(truth_path):
        with open(truth_path, encoding="utf-8") as fh:
            existing = json.load(fh).get("series", {})
    existing.update(truth_series)

    truth = {
        "phantom": PHANTOM_ID,
        "version": PHANTOM_VERSION,
        "purpose": (
            "longitudinal SPECT registration where the two series no longer show the same "
            "thing: lesions appear, change size and disappear between timepoints"
        ),
        "content": (
            "egg-shaped body; background cloud (band-limited random Fourier series) + organ "
            "uptake in the `tex` arm, nothing in the `smooth` arm; up to 25 spherical lesions"
        ),
        "design": {
            "factors": {
                "content": CONTENT_NOTE,
                "transform": {
                    "id": "identity — the truth is that nothing moved",
                    "rigid": "known rigid repositioning",
                    "deform": "known rigid + analytic deformation",
                },
                "background": TEXTURE_NOTE,
            },
            "fixed_series": {
                "tex": f"{PHANTOM_ID}-t20-id-tex",
                "smooth": f"{PHANTOM_ID}-t20-id-smooth",
            },
            "interesting_pairs": [
                "t20-id-* vs t25-*-*   : 20 lesions -> 25, all resized (moderate content change)",
                "t20-id-* vs t00-*-*   : 20 lesions -> none (extreme content change)",
                "t25-id-* vs t00-*-*   : disappearance only, positions unchanged",
                "t20-id-* vs t20-*-*   : control — transform only, content identical",
            ],
            "note": (
                "Compare a `tex` result only with another `tex` result. The `smooth` arm has no "
                "background structure by construction, so its numbers are a floor, not a score."
            ),
        },
        "direction_convention": (
            "transform_fixed_to_moving maps a point of the FIXED series to the point of the "
            "MOVING series holding the same anatomy: q = T(p). This is the transform a "
            "registration must recover, and the one GRAPHY passes to computeFusionSlice as xf."
        ),
        "euler_convention": (
            "R = Rz(rz) . Ry(ry) . Rx(rx), degrees, right-handed about patient LPS, about "
            "rotation_centre_mm; identical to mat4FromEulerDeg in frontend/src/viewer/regTransform.ts"
        ),
        "frame_of_reference": (
            "Every series declares a DIFFERENT FrameOfReferenceUID, as two SPECT sessions months "
            "apart do. An engine that branches on FoR agreement therefore takes its "
            "'separately acquired' path for every pair here."
        ),
        "acquisition": {
            "psf_pre_fwhm_mm": PSF_PRE_FWHM_MM,
            "psf_post_fwhm_mm": PSF_POST_FWHM_MM,
            "effective_fwhm_mm": float(np.hypot(PSF_PRE_FWHM_MM, PSF_POST_FWHM_MM)),
            "count_scale": COUNT_SCALE,
            "air_fraction": AIR_FRACTION,
            "store_scale": STORE_SCALE,
            "stored_values": (
                "counts x store_scale. The Poisson draw sets the noise at a realistic count "
                "level; the post-filter output is fractional and is scaled before rounding so "
                "that it is not quantised away. Rounding straight to counts left the body with "
                "about 16 grey levels, which distorts MI's histogram and MIND-SSC's descriptors."
            ),
            "air": (
                "Outside the body the activity is AIR_FRACTION of the body background, not zero. "
                "A zero exterior gives a perfectly sharp, noise-free silhouette that no real "
                "acquisition offers and that is a strong enough cue to carry an alignment on its "
                "own. air_statistics per series reports what was actually written."
            ),
            "order": (
                "analytic activity on a grid FINE x finer -> pre-PSF blur -> bin down -> Poisson "
                "-> post-filter. Partial-volume loss emerges from this order rather than being "
                "applied afterwards; the post-filter is what makes the noise correlated."
            ),
            "noise_seeds": "distinct per series, so matching noise cannot be used as a cue",
            "units": "counts; no rescale pair is written (NM convention)",
        },
        "body": {
            "kind": "egg",
            "form": "((x/(a*w))^2 + (y/(b*w))^2 + (z/c)^2 <= 1, w = 1 + taper*(z/c)",
            "semi_axes_mm": list(EGG_SEMI_AXES_MM),
            "taper": EGG_TAPER,
        },
        # An ellipsoid inscribed in the egg, so score_registration.mjs — which
        # understands `kind: "ellipsoid"` — can restrict the displacement error to
        # the body without any change. Judging displacement over the whole field
        # of view lets the empty air outside dominate.
        "evaluation_region": {
            "kind": "ellipsoid",
            "centre_mm": [0.0, 0.0, 0.0],
            "semi_axes_mm": [
                EGG_SEMI_AXES_MM[0] * (1.0 - EGG_TAPER),
                EGG_SEMI_AXES_MM[1] * (1.0 - EGG_TAPER),
                EGG_SEMI_AXES_MM[2] * 0.95,
            ],
            "note": "inscribed in the egg for every z; outside it the estimate is an extrapolation",
        },
        "lesions": LESIONS,
        "observability": (
            "lesion_measurements[].cnr is measured on the written volume. A landmark whose CNR is "
            "below ~3 is not detectable after the 10 mm effective PSF and Poisson statistics, and "
            "a large TRE there is a property of the data, not of the engine. Judge accuracy on "
            "detectable landmarks and report the rest separately."
        ),
        "acceptance_targets": {
            "rigid_translation_error_mm": 0.5,
            "rigid_rotation_error_deg": 0.2,
            "deformable_displacement_rmse_mm": 1.0,
            "jacobian_negative_fraction": 0.0,
            "note": (
                "inherited from fw/registration-design.md §9.1/§9.4 so the scorer has limits to "
                "print. They were set for a 1 mm CT-like phantom and are almost certainly the "
                "wrong scale for a 4.42 mm SPECT grid — fix them with measurements, not opinion."
            ),
        },
        "series": existing,
    }
    # 🚨 Windows の既定は cp932。encoding を省略すると非 ASCII で落ちる
    with open(truth_path, "w", encoding="utf-8") as fh:
        json.dump(truth, fh, indent=2, ensure_ascii=False)
    print(f"  ground truth -> {truth_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

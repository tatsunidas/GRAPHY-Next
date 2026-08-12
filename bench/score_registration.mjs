#!/usr/bin/env node
// GRAPHY-Next Benchmark Phantom (GNBP-2R)
// Copyright (C) 2026 Visionary Imaging Services, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Score an estimated registration against the GNBP-2R ground truth.
//
// The phantom on its own only says "here is a known transform". This turns a
// candidate answer into the numbers the acceptance criteria are written in
// (`fw/registration-design.md` §9.4): target registration error at landmarks,
// displacement error over the volume, and — for rigid truth — the translation
// and rotation error in the units the parameters were published in.
//
// It deliberately does not talk to the application. An engine that can produce
// a transform can be scored here with no browser, no DICOM read and no
// rendering, which keeps "is the maths right?" separate from "does the viewer
// show it?". Wiring this to a real run of GRAPHY is R3's job.
//
// Usage:
//   node score_registration.mjs --series rigid --estimate identity
//   node score_registration.mjs --series rigid --estimate est.json
//   node score_registration.mjs --series deform --estimate est.json --json
//
// Estimate file (fixed -> moving, the same direction the truth publishes):
//   { "matrix_4x4_row_major": [ ...16 numbers... ] }
// or
//   { "translation_mm": [x,y,z], "euler_deg": [rx,ry,rz] }
// or, for a deformable estimate (R4), a displacement field on a regular grid:
//   {
//     "matrix_4x4_row_major": [...],        // optional rigid part, applied FIRST
//     "displacement_field": {
//       "dims": [nx, ny, nz],
//       "origin_mm": [x, y, z],
//       "spacing_mm": [sx, sy, sz],
//       "displacements_mm": [ux0, uy0, uz0, ux1, ...]   // control-point order i fastest
//     }
//   }
//
// COMPOSITION ORDER: the displacement field is applied BEFORE the matrix, i.e.
//   q = M . (p + u(p))
// which is the order the engine produces (see regDeformable.ts "合成の順序").
// Getting this backwards changes the answer by a second-order amount that a
// measurement cannot distinguish, so it is stated here rather than inferred.

import { readFileSync } from "node:fs";
import { argv, exit } from "node:process";

// ── argument parsing ─────────────────────────────────────────────────────────

function parseArgs() {
  const out = {
    truth: "./phantom/GNBP-2R_ground_truth.json",
    series: null,
    estimate: "identity",
    json: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--truth") out.truth = argv[++i];
    else if (a === "--series") out.series = argv[++i];
    else if (a === "--estimate") out.estimate = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(readFileSync(new URL(import.meta.url)).toString().split("\n")
        .filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
      exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      exit(2);
    }
  }
  if (!out.series) {
    console.error("--series is required (rigid | affine | deform | multimodal)");
    exit(2);
  }
  return out;
}

// ── small linear algebra (row-major 4x4, LPS millimetres) ────────────────────

const IDENTITY4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** R = Rz(rz) . Ry(ry) . Rx(rx) — identical to regTransform.ts and the generator. */
function eulerToMatrix(rxDeg, ryDeg, rzDeg) {
  const d = Math.PI / 180;
  const cx = Math.cos(rxDeg * d), sx = Math.sin(rxDeg * d);
  const cy = Math.cos(ryDeg * d), sy = Math.sin(ryDeg * d);
  const cz = Math.cos(rzDeg * d), sz = Math.sin(rzDeg * d);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

function applyMatrix(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

function linearPart(m) {
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
}

/** Geodesic angle between two rotation matrices, in degrees. */
function rotationAngleBetween(a, b) {
  // trace(a^T b)
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tr += a[j * 3 + i] * b[j * 3 + i];
  const c = Math.min(1, Math.max(-1, (tr - 1) / 2));
  return (Math.acos(c) * 180) / Math.PI;
}

function norm(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ── the truth transform ──────────────────────────────────────────────────────

/**
 * Rebuild T(p) from the published parameters.
 *
 * The deformation is re-evaluated from its closed form rather than read from a
 * sampled field: the phantom publishes the formula precisely so that anyone can
 * evaluate the truth anywhere, at full precision, without shipping a dense
 * displacement volume.
 */
function truthTransform(entry) {
  const m = entry.transform_fixed_to_moving.matrix_4x4_row_major;
  const def = entry.transform_fixed_to_moving.deformation;
  if (!def) return (p) => applyMatrix(m, p);
  const k = def.k_per_mm;
  const [ax, ay, az] = def.amplitude_mm;
  return (p) => {
    const q = applyMatrix(m, p);
    return [
      q[0] + ax * Math.sin(k * q[1]) * Math.cos(k * q[2]),
      q[1] + ay * Math.sin(k * q[2]) * Math.cos(k * q[0]),
      q[2] + az * Math.sin(k * q[0]) * Math.cos(k * q[1]),
    ];
  };
}

/** Trilinear sampling of a control-point displacement field (edge-clamped). */
function makeFieldSampler(field) {
  const [nx, ny, nz] = field.dims;
  const o = field.origin_mm, sp = field.spacing_mm;
  const d = field.displacements_mm;
  if (d.length !== nx * ny * nz * 3) {
    console.error(`displacement_field: ${d.length} values do not match dims ${nx}x${ny}x${nz}`);
    exit(2);
  }
  return (p) => {
    let gi = (p[0] - o[0]) / sp[0], gj = (p[1] - o[1]) / sp[1], gk = (p[2] - o[2]) / sp[2];
    gi = Math.min(nx - 1, Math.max(0, gi));
    gj = Math.min(ny - 1, Math.max(0, gj));
    gk = Math.min(nz - 1, Math.max(0, gk));
    const i0 = Math.floor(gi), j0 = Math.floor(gj), k0 = Math.floor(gk);
    const i1 = Math.min(nx - 1, i0 + 1), j1 = Math.min(ny - 1, j0 + 1), k1 = Math.min(nz - 1, k0 + 1);
    const fi = gi - i0, fj = gj - j0, fk = gk - k0;
    const at = (i, j, k, c) => d[((k * ny + j) * nx + i) * 3 + c];
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const c00 = at(i0, j0, k0, c) + (at(i1, j0, k0, c) - at(i0, j0, k0, c)) * fi;
      const c10 = at(i0, j1, k0, c) + (at(i1, j1, k0, c) - at(i0, j1, k0, c)) * fi;
      const c01 = at(i0, j0, k1, c) + (at(i1, j0, k1, c) - at(i0, j0, k1, c)) * fi;
      const c11 = at(i0, j1, k1, c) + (at(i1, j1, k1, c) - at(i0, j1, k1, c)) * fi;
      const c0 = c00 + (c10 - c00) * fj;
      const c1 = c01 + (c11 - c01) * fj;
      out[c] = p[c] + c0 + (c1 - c0) * fk;
    }
    return out;
  };
}

function loadEstimate(spec) {
  if (spec === "identity") return { label: "identity (no registration)", matrix: IDENTITY4 };
  const raw = JSON.parse(readFileSync(spec, "utf8"));
  if (raw.displacement_field) {
    const matrix = Array.isArray(raw.matrix_4x4_row_major) ? raw.matrix_4x4_row_major : IDENTITY4;
    const field = makeFieldSampler(raw.displacement_field);
    // 変位場を先、行列を後（上の COMPOSITION ORDER）。
    return { label: spec, matrix, deformable: true, map: (p) => applyMatrix(matrix, field(p)) };
  }
  if (Array.isArray(raw.matrix_4x4_row_major)) {
    if (raw.matrix_4x4_row_major.length !== 16) {
      console.error("matrix_4x4_row_major must have 16 elements");
      exit(2);
    }
    return { label: spec, matrix: raw.matrix_4x4_row_major };
  }
  if (Array.isArray(raw.translation_mm) && Array.isArray(raw.euler_deg)) {
    const r = eulerToMatrix(...raw.euler_deg);
    const c = raw.rotation_centre_mm ?? [0, 0, 0];
    const t = raw.translation_mm;
    // Same composition as the generator: T(p) = C + R(p - C) + t.
    const m = [
      r[0], r[1], r[2], c[0] + t[0] - (r[0] * c[0] + r[1] * c[1] + r[2] * c[2]),
      r[3], r[4], r[5], c[1] + t[1] - (r[3] * c[0] + r[4] * c[1] + r[5] * c[2]),
      r[6], r[7], r[8], c[2] + t[2] - (r[6] * c[0] + r[7] * c[1] + r[8] * c[2]),
      0, 0, 0, 1,
    ];
    return { label: spec, matrix: m };
  }
  console.error("estimate needs matrix_4x4_row_major, or translation_mm + euler_deg");
  return exit(2);
}

// ── scoring ──────────────────────────────────────────────────────────────────

function score(entry, estimate) {
  const truth = truthTransform(entry);
  const est = estimate.map ?? ((p) => applyMatrix(estimate.matrix, p));

  // Target registration error at the published landmarks.
  const tre = entry.landmarks.map((lm) => {
    const e = est(lm.fixed_mm);
    return { name: lm.name, error_mm: norm([e[0] - lm.moving_mm[0], e[1] - lm.moving_mm[1], e[2] - lm.moving_mm[2]]) };
  });
  const treSorted = tre.map((t) => t.error_mm).sort((a, b) => a - b);

  // Displacement error over the written field of view. Sampled on a coarse
  // lattice: the error field of a linear estimate is itself linear, and for the
  // deformable case the truth is band-limited, so a fine lattice would add cost
  // without changing the statistics.
  const g = entry.geometry;
  const halfX = ((g.columns - 1) / 2) * g.pixel_spacing_mm;
  const halfY = ((g.rows - 1) / 2) * g.pixel_spacing_mm;
  const halfZ = ((g.slices - 1) / 2) * g.slice_thickness_mm;
  const errs = [];
  const inside = [];   // 評価領域（＝ファントムの実体）内だけ
  const region = truthDoc.evaluation_region;
  const inRegion = (p) => {
    if (!region || region.kind !== "ellipsoid") return true;
    const c = region.centre_mm, a = region.semi_axes_mm;
    return ((p[0] - c[0]) / a[0]) ** 2 + ((p[1] - c[1]) / a[1]) ** 2 + ((p[2] - c[2]) / a[2]) ** 2 <= 1;
  };
  const STEP = 16;
  for (let i = 0; i <= STEP; i++) {
    for (let j = 0; j <= STEP; j++) {
      for (let k = 0; k <= STEP; k++) {
        const p = [
          -halfX + (2 * halfX * i) / STEP,
          -halfY + (2 * halfY * j) / STEP,
          -halfZ + (2 * halfZ * k) / STEP,
        ];
        const a = truth(p), b = est(p);
        const e = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
        errs.push(e);
        if (inRegion(p)) inside.push(e);
      }
    }
  }
  const sq = errs.reduce((s, e) => s + e * e, 0) / errs.length;
  const errSorted = [...errs].sort((a, b) => a - b);
  const insideSorted = [...inside].sort((a, b) => a - b);
  const sqIn = inside.length ? inside.reduce((s, e) => s + e * e, 0) / inside.length : NaN;

  const result = {
    series: entry.series,
    kind: entry.kind,
    estimate: estimate.label,
    landmark_tre_mm: {
      mean: treSorted.reduce((s, v) => s + v, 0) / treSorted.length,
      p95: percentile(treSorted, 0.95),
      max: treSorted[treSorted.length - 1],
      per_landmark: tre,
    },
    displacement_error_mm: {
      sampled_points: errs.length,
      rmse: Math.sqrt(sq),
      p95: percentile(errSorted, 0.95),
      max: errSorted[errSorted.length - 1],
    },
    // ★ 合否はこちらで見る。視野全体の RMSE は体の外（データが無く推定が外挿に
    // なる領域）が支配するので、「体の中で合っているか」を表さない。
    displacement_error_in_region_mm: inside.length ? {
      sampled_points: inside.length,
      rmse: Math.sqrt(sqIn),
      p95: percentile(insideSorted, 0.95),
      max: insideSorted[insideSorted.length - 1],
    } : null,
  };

  // Parameter-space error, reported only where it means something: the truth
  // has to be a rigid motion for "translation error" and "rotation error" to be
  // the same quantities the acceptance targets are written in. For the affine
  // and deformable cases the millimetre errors above are the honest measure.
  const t = entry.transform_fixed_to_moving;
  const isRigidTruth = !t.deformation && !t.scale && !estimate.deformable;
  if (isRigidTruth) {
    const tm = t.matrix_4x4_row_major;
    result.parameter_error = {
      translation_mm: norm([
        estimate.matrix[3] - tm[3],
        estimate.matrix[7] - tm[7],
        estimate.matrix[11] - tm[11],
      ]),
      rotation_deg: rotationAngleBetween(linearPart(tm), linearPart(estimate.matrix)),
    };
  }
  return result;
}

function verdict(result, targets) {
  const checks = [];
  if (result.parameter_error) {
    checks.push({
      name: "translation error",
      value: result.parameter_error.translation_mm,
      limit: targets.rigid_translation_error_mm,
      unit: "mm",
    });
    checks.push({
      name: "rotation error",
      value: result.parameter_error.rotation_deg,
      limit: targets.rigid_rotation_error_deg,
      unit: "deg",
    });
  } else {
    const inRegion = result.displacement_error_in_region_mm;
    checks.push({
      name: inRegion ? "displacement RMSE (in region)" : "displacement RMSE",
      value: (inRegion ?? result.displacement_error_mm).rmse,
      limit: targets.deformable_displacement_rmse_mm,
      unit: "mm",
    });
  }
  for (const c of checks) c.pass = c.value <= c.limit;
  return checks;
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs();
let truthDoc;
try {
  truthDoc = JSON.parse(readFileSync(args.truth, "utf8"));
} catch (e) {
  console.error(`cannot read ground truth (${args.truth}): ${e.message}`);
  console.error("generate it first:  python3 make_phantom_2r.py --out ./phantom");
  exit(2);
}
const entry = truthDoc.series?.[args.series];
if (!entry) {
  console.error(`series "${args.series}" is not in the ground truth `
    + `(have: ${Object.keys(truthDoc.series ?? {}).join(", ") || "none"})`);
  exit(2);
}

const estimate = loadEstimate(args.estimate);
const result = score(entry, estimate);
const checks = verdict(result, truthDoc.acceptance_targets);

if (args.json) {
  console.log(JSON.stringify({ ...result, checks }, null, 2));
  exit(checks.every((c) => c.pass) ? 0 : 1);
}

console.log(`${result.series}  (${result.kind})`);
console.log(`  estimate: ${result.estimate}`);
console.log(`  landmark TRE   mean ${result.landmark_tre_mm.mean.toFixed(3)} mm  `
  + `p95 ${result.landmark_tre_mm.p95.toFixed(3)}  max ${result.landmark_tre_mm.max.toFixed(3)}`);
console.log(`  displacement   rmse ${result.displacement_error_mm.rmse.toFixed(3)} mm  `
  + `p95 ${result.displacement_error_mm.p95.toFixed(3)}  max ${result.displacement_error_mm.max.toFixed(3)}  [視野全体]`);
if (result.displacement_error_in_region_mm) {
  const r = result.displacement_error_in_region_mm;
  console.log(`                 rmse ${r.rmse.toFixed(3)} mm  p95 ${r.p95.toFixed(3)}  max ${r.max.toFixed(3)}`
    + `  [評価領域内・n=${r.sampled_points}]`);
}
if (result.parameter_error) {
  console.log(`  parameters     translation ${result.parameter_error.translation_mm.toFixed(3)} mm  `
    + `rotation ${result.parameter_error.rotation_deg.toFixed(3)} deg`);
}
console.log("");
for (const c of checks) {
  console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}: `
    + `${c.value.toFixed(3)} ${c.unit} (limit ${c.limit} ${c.unit})`);
}
if (entry.transform_fixed_to_moving.deformation && !estimate.deformable) {
  console.log("");
  console.log("  note: the estimate is linear, so this measures how much of the");
  console.log("        misalignment a rigid/affine answer can remove on a deformable");
  console.log("        case — not a defect in the engine. Dense displacement-field");
  console.log("        estimates arrive with R4.");
}
exit(checks.every((c) => c.pass) ? 0 : 1);

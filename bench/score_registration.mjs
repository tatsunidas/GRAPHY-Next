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
//
// LIMITATION: estimates are linear (rigid/affine) only. Scoring the deformable
// series with a linear estimate is still useful — it measures how much of the
// misalignment a rigid answer can remove, i.e. the ceiling any rigid engine
// faces on that case — but it cannot pass the deformable target, and a FAIL
// there does not mean the engine is broken. A dense displacement-field input
// arrives with R4, when the engine that produces one exists and its output
// format is settled; inventing that format before there is a producer would
// only guarantee a rewrite.

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

function loadEstimate(spec) {
  if (spec === "identity") return { label: "identity (no registration)", matrix: IDENTITY4 };
  const raw = JSON.parse(readFileSync(spec, "utf8"));
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
  const est = (p) => applyMatrix(estimate.matrix, p);

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
        errs.push(norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]));
      }
    }
  }
  const sq = errs.reduce((s, e) => s + e * e, 0) / errs.length;
  const errSorted = [...errs].sort((a, b) => a - b);

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
  };

  // Parameter-space error, reported only where it means something: the truth
  // has to be a rigid motion for "translation error" and "rotation error" to be
  // the same quantities the acceptance targets are written in. For the affine
  // and deformable cases the millimetre errors above are the honest measure.
  const t = entry.transform_fixed_to_moving;
  const isRigidTruth = !t.deformation && !t.scale;
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
    checks.push({
      name: "displacement RMSE",
      value: result.displacement_error_mm.rmse,
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
  + `p95 ${result.displacement_error_mm.p95.toFixed(3)}  max ${result.displacement_error_mm.max.toFixed(3)}`);
if (result.parameter_error) {
  console.log(`  parameters     translation ${result.parameter_error.translation_mm.toFixed(3)} mm  `
    + `rotation ${result.parameter_error.rotation_deg.toFixed(3)} deg`);
}
console.log("");
for (const c of checks) {
  console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}: `
    + `${c.value.toFixed(3)} ${c.unit} (limit ${c.limit} ${c.unit})`);
}
if (entry.transform_fixed_to_moving.deformation) {
  console.log("");
  console.log("  note: the estimate is linear, so this measures how much of the");
  console.log("        misalignment a rigid/affine answer can remove on a deformable");
  console.log("        case — not a defect in the engine. Dense displacement-field");
  console.log("        estimates arrive with R4.");
}
exit(checks.every((c) => c.pass) ? 0 : 1);

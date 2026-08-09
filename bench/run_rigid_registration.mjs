#!/usr/bin/env node
// GRAPHY-Next Benchmark (GNBP-2R)
// Copyright (C) 2026 Visionary Imaging Services, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Run GRAPHY's rigid registration engine on GNBP-2R and score the answer
// against the phantom's analytic ground truth.
//
// This is the measurement the R2 phantom exists for. The engine (regCore.ts)
// imports neither the DOM nor cornerstone, so the very code the application
// runs can be executed here with no browser, no rendering and no viewer state —
// which means an accuracy number produced here is about the algorithm, not
// about the UI happening to be in the right state.
//
// Usage:
//   node run_rigid_registration.mjs --series rigid
//   node run_rigid_registration.mjs --series rigid,multimodal --phantom ./phantom
//   node run_rigid_registration.mjs --series rigid --out /tmp/est.json
//
// Requires the phantom to have been generated:
//   python3 make_phantom_2r.py --out ./phantom

import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { argv, exit } from "node:process";

// ── arguments ────────────────────────────────────────────────────────────────

const args = {
  phantom: "./phantom",
  truth: null,
  series: "rigid",
  out: null,
  samples: 3000,
  iterations: 120,
  seed: 76,          // frontend/src/viewer/regParams.ts の DEFAULT_SEED と揃える
  pyramid: null,
  deformable: false,
  controlSpacings: null,
  skipRigid: false,
  desc: null,
  maxDisp: null,
  step: null,
  smooth: null,
  reg: null,
  iters: null,
  metric: null,
};
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--phantom") args.phantom = argv[++i];
  else if (a === "--truth") args.truth = argv[++i];
  else if (a === "--series") args.series = argv[++i];
  else if (a === "--out") args.out = argv[++i];
  else if (a === "--samples") args.samples = Number(argv[++i]);
  else if (a === "--iterations") args.iterations = Number(argv[++i]);
  else if (a === "--seed") args.seed = Number(argv[++i]);
  else if (a === "--pyramid") args.pyramid = argv[++i].split(",").map(Number);
  else if (a === "--deformable") args.deformable = true;
  else if (a === "--skip-rigid") { args.skipRigid = true; args.deformable = true; }
  else if (a === "--control") args.controlSpacings = argv[++i].split(",").map(Number);
  else if (a === "--desc") args.desc = Number(argv[++i]);
  else if (a === "--max-disp") args.maxDisp = Number(argv[++i]);
  else if (a === "--disp-step") args.step = Number(argv[++i]);
  else if (a === "--smooth") args.smooth = Number(argv[++i]);
  else if (a === "--reg") args.reg = Number(argv[++i]);
  else if (a === "--iters") args.iters = Number(argv[++i]);
  else if (a === "--metric") args.metric = argv[++i];
  else { console.error(`unknown argument: ${a}`); exit(2); }
}
const truthPath = args.truth ?? join(args.phantom, "GNBP-2R_ground_truth.json");

// ── engine (TypeScript, compiled on demand) ──────────────────────────────────

/**
 * The engine lives in the frontend as TypeScript. Rather than duplicating it
 * here — which would guarantee the benchmark drifts from what ships — bundle
 * the real modules with the frontend's own esbuild and import the result.
 * Nothing in regCore/regGeometry/regMetrics/regTransform touches the DOM, so
 * the bundle runs unmodified under node.
 */
function loadEngine() {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const viewer = join(root, "frontend/src/viewer");
  const dir = mkdtempSync(join(tmpdir(), "gnbp-reg-"));
  // 最適化本体と幾何の両方が要るので、まとめて再輸出する入口を作って束ねる。
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, `export * from ${JSON.stringify(join(viewer, "regCore"))};\n`
    + `export * from ${JSON.stringify(join(viewer, "regGeometry"))};\n`
    + `export * from ${JSON.stringify(join(viewer, "regDeformable"))};\n`);
  const outfile = join(dir, "engine.mjs");
  const esbuild = join(root, "frontend/node_modules/.bin/esbuild");
  execFileSync(esbuild, [entry, "--bundle", "--format=esm", "--platform=node", `--outfile=${outfile}`], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  return import(outfile);
}

// ── minimal DICOM reader ─────────────────────────────────────────────────────

/**
 * Read the uncompressed Explicit VR Little Endian series the phantom writes.
 *
 * <p>Deliberately minimal: this must read GNBP-2R and nothing else. A general
 * DICOM parser here would be a second implementation of something the
 * application already has, with its own bugs, and would make a failure
 * ambiguous ("is the engine wrong or is the benchmark's parser wrong?").
 */
function readDicom(path) {
  const buf = readFileSync(path);
  if (buf.length < 132 || buf.toString("latin1", 128, 132) !== "DICM") {
    throw new Error(`not a Part-10 file: ${path}`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tags = new Map();
  let pos = 132;
  let pixelOffset = -1;
  let pixelLength = 0;

  while (pos + 8 <= buf.length) {
    const group = dv.getUint16(pos, true);
    const element = dv.getUint16(pos + 2, true);
    const vr = buf.toString("latin1", pos + 4, pos + 6);
    let len, valueStart;
    if (["OB", "OW", "OF", "SQ", "UT", "UN"].includes(vr)) {
      len = dv.getUint32(pos + 8, true);
      valueStart = pos + 12;
    } else {
      len = dv.getUint16(pos + 6, true);
      valueStart = pos + 8;
    }
    const tag = `${group.toString(16).padStart(4, "0")}${element.toString(16).padStart(4, "0")}`;
    if (tag === "7fe00010") { pixelOffset = valueStart; pixelLength = len; break; }
    if (len === 0xffffffff) {
      throw new Error("undefined-length item is not supported (the phantom never writes one)");
    }
    tags.set(tag, { vr, start: valueStart, len });
    pos = valueStart + len + (len % 2);
  }
  if (pixelOffset < 0) throw new Error(`no PixelData in ${path}`);

  /**
   * 値の取り出し。**VR ごとに復号する** — US/UL のような 2 進 VR を文字列として
   * 読むと `Number()` が NaN を返し、Rows/Columns が静かに壊れる（実際に踏んだ）。
   */
  const num = (tag, i = 0) => {
    const t = tags.get(tag);
    if (!t) return undefined;
    switch (t.vr) {
      case "US": return dv.getUint16(t.start + i * 2, true);
      case "SS": return dv.getInt16(t.start + i * 2, true);
      case "UL": return dv.getUint32(t.start + i * 4, true);
      case "SL": return dv.getInt32(t.start + i * 4, true);
      case "FL": return dv.getFloat32(t.start + i * 4, true);
      case "FD": return dv.getFloat64(t.start + i * 8, true);
      default: {
        const parts = buf.toString("latin1", t.start, t.start + t.len).trim().split("\\");
        return Number(parts[i]);
      }
    }
  };
  const str = (tag) => {
    const t = tags.get(tag);
    return t ? buf.toString("latin1", t.start, t.start + t.len).trim() : "";
  };
  const rows = num("00280010");
  const cols = num("00280011");
  const stored = new Uint16Array(buf.buffer, buf.byteOffset + pixelOffset, pixelLength / 2);
  const slope = num("00281053") ?? 1;
  const intercept = num("00281052") ?? 0;
  const pixels = new Float32Array(rows * cols);
  for (let n = 0; n < pixels.length; n++) pixels[n] = stored[n] * slope + intercept;

  return {
    rows,
    cols,
    pixels,
    ipp: [num("00200032", 0), num("00200032", 1), num("00200032", 2)],
    iop: [0, 1, 2, 3, 4, 5].map((i) => num("00200037", i)),
    pixelSpacingRow: num("00280030", 0),
    pixelSpacingCol: num("00280030", 1),
    frameOfReferenceUid: str("00200052"),
    seriesDescription: str("0008103e"),
  };
}

/** Read a directory of slices into the engine's volume type. */
function readSeries(dir, makeVolume) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".dcm")).sort();
  if (files.length === 0) throw new Error(`no DICOM files in ${dir}`);
  const slices = files.map((f) => readDicom(join(dir, f)));

  // Sort by position along the slice normal so the stack is geometrically
  // ordered rather than name-ordered. The phantom happens to write them in
  // order; relying on that would make this quietly wrong for anything else.
  const iop = slices[0].iop;
  const n = [
    iop[1] * iop[5] - iop[2] * iop[4],
    iop[2] * iop[3] - iop[0] * iop[5],
    iop[0] * iop[4] - iop[1] * iop[3],
  ];
  slices.sort((a, b) =>
    (a.ipp[0] * n[0] + a.ipp[1] * n[1] + a.ipp[2] * n[2]) -
    (b.ipp[0] * n[0] + b.ipp[1] * n[1] + b.ipp[2] * n[2]));

  const { rows, cols } = slices[0];
  const data = new Float32Array(rows * cols * slices.length);
  slices.forEach((s, k) => data.set(s.pixels, k * rows * cols));

  const step = slices.length > 1
    ? [slices[1].ipp[0] - slices[0].ipp[0], slices[1].ipp[1] - slices[0].ipp[1], slices[1].ipp[2] - slices[0].ipp[2]]
    : [n[0], n[1], n[2]];

  return {
    volume: makeVolume(
      data,
      [cols, rows, slices.length],
      iop,
      slices[0].ipp,
      slices[0].pixelSpacingCol,
      slices[0].pixelSpacingRow,
      step,
    ),
    frameOfReferenceUid: slices[0].frameOfReferenceUid,
    description: slices[0].seriesDescription,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

const truth = JSON.parse(readFileSync(truthPath, "utf8"));
const engine = await loadEngine();
const wanted = args.series.split(",").map((s) => s.trim()).filter(Boolean);

const fixedDir = join(args.phantom, "GNBP-2R-fixed");
const fixed = readSeries(fixedDir, engine.makeVolume);

const results = [];
for (const name of wanted) {
  const entry = truth.series?.[name];
  if (!entry) { console.error(`series "${name}" is not in the ground truth`); exit(2); }
  const moving = readSeries(join(args.phantom, `GNBP-2R-${name}`), engine.makeVolume);

  const sameFor = fixed.frameOfReferenceUid === moving.frameOfReferenceUid;
  // GNBP-2R の全系列は Shepp-Logan の CT 符号化。multimodal だけは非単調な
  // 強度写像がかかっているので、そこだけ MI を使う（実運用では呼び出し側が
  // Modality から決める。ここでは系列の定義から分かる）。
  const metric = args.metric ?? (name === "multimodal" ? "mi" : "ncc");

  const t0 = Date.now();
  // --skip-rigid: 剛体を飛ばして非剛体だけを見る。変形が主体の症例では
  // 剛体段が変形に引っ張られて**かえって悪化する**ことがあるため、その切り分け用。
  const r = args.skipRigid ? null : engine.registerRigid(fixed.volume, moving.volume, {
    metric,
    sameFrameOfReference: sameFor,
    samplesPerIteration: args.samples,
    maxIterationsPerLevel: args.iterations,
    seed: args.seed,
    ...(args.pyramid ? { pyramidMm: args.pyramid } : {}),
  });
  const seconds = (Date.now() - t0) / 1000;

  const estimate = r
    ? { matrix_4x4_row_major: Array.from(r.transform.matrix) }
    : {};

  if (args.deformable) {
    const t1 = Date.now();
    const d = engine.registerDeformable(fixed.volume, moving.volume, r ? r.transform : null, {
      ...(args.controlSpacings ? { controlSpacingsMm: args.controlSpacings } : {}),
      ...(args.desc ? { descriptorSpacingMm: args.desc } : {}),
      ...(args.maxDisp ? { maxDisplacementMm: args.maxDisp } : {}),
      ...(args.step ? { displacementStepMm: args.step } : {}),
      ...(args.smooth !== null ? { smoothingSigma: args.smooth } : {}),
      ...(args.reg !== null ? { regularizationWeight: args.reg } : {}),
      ...(args.iters !== null ? { iterations: args.iters } : {}),
    });
    const dSeconds = (Date.now() - t1) / 1000;
    estimate.displacement_field = {
      dims: Array.from(d.transform.dims),
      origin_mm: Array.from(d.transform.origin),
      spacing_mm: Array.from(d.transform.spacing),
      displacements_mm: Array.from(d.transform.displacements),
    };
    console.log(`  非剛体 ${dSeconds.toFixed(1)} s  制御格子 ${d.controlDims.join("x")}`
      + `  候補 ${d.candidateCount}  最大変位 ${d.maxDisplacementMm.toFixed(2)} mm`);
    console.log(`       Jacobian ${d.jacobian.min.toFixed(3)}–${d.jacobian.max.toFixed(3)}`
      + `  負値率 ${(d.jacobian.negativeFraction * 100).toFixed(2)} %`
      + (d.jacobian.negativeFraction > 0 ? "  ← ★折り返しあり（不合格）" : ""));
  }
  const estPath = args.out ?? join(mkdtempSync(join(tmpdir(), "gnbp-est-")), `${name}.json`);
  writeFileSync(estPath, JSON.stringify(estimate, null, 2));

  console.log(`\n=== ${entry.series} ===`);
  if (r) {
    console.log(`  FoR ${sameFor ? "一致" : "不一致"} / 指標 ${metric} / 初期化 ${r.initialization}`);
    console.log(`  剛体 ${seconds.toFixed(1)} s   段ごとの反復 ${r.levels.map((l) => `${l.spacingMm}mm:${l.iterations}`).join(" ")}`);
    console.log(`  推定 平行移動 [${r.parameters.translationMm.map((v) => v.toFixed(2)).join(", ")}] mm`);
    console.log(`       回転     [${r.parameters.eulerDeg.map((v) => v.toFixed(2)).join(", ")}] deg (中心まわり)`);
  } else {
    console.log(`  剛体はスキップ（--skip-rigid）`);
  }

  // 採点器は不合格を終了コード 1 で返す。affine / deform を剛体で解く回は
  // **不合格が正しい結果**なので、ここで落ちてはいけない（落とすと残りの系列が
  // 測れず、表が埋まらない）。出力だけ取り出して続行する。
  const scorer = resolve(new URL("./score_registration.mjs", import.meta.url).pathname);
  let out;
  try {
    out = execFileSync("node", [scorer, "--truth", truthPath, "--series", name, "--estimate", estPath],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  } catch (e) {
    if (e.stdout == null) throw e; // 採点器が起動すらしていない＝本当の異常
    out = e.stdout;
  }
  console.log(out.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n"));

  results.push({ series: name, seconds, parameters: r?.parameters ?? null, estimatePath: estPath });
}

console.log("\n注: 上の PASS/FAIL は真値 JSON の acceptance_targets に対する判定。");
console.log("    deform 系列は線形推定では目標に届かない（非剛体は R4）。");

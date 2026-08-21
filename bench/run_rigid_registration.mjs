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
// GNBP-5N (longitudinal SPECT, multi-frame NM) works through the same path; it
// needs its own truth file and its own fixed series, because "fixed" is one of
// the eighteen cells rather than a series of its own:
//   node run_rigid_registration.mjs --truth ./phantom/GNBP-5N_ground_truth.json \
//        --fixed t20-id-tex --series t25-rigid-tex
//
// Requires the phantom to have been generated:
//   python3 make_phantom_2r.py --out ./phantom
//   python3 make_phantom_5n.py --out ./phantom

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { argv, exit } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readSeries } from "./nmVolume.mjs";

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
  fixed: null,
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
  else if (a === "--fixed") args.fixed = argv[++i];
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
  // 
  // URL の pathname を resolve に渡すと Windows で "C:\C:\Users\..." になる
  // （pathname が "/C:/Users/..." なので resolve がドライブを前置する）。fileURLToPath を通す。
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const viewer = join(root, "frontend/src/viewer");
  const dir = mkdtempSync(join(tmpdir(), "gnbp-reg-"));
  // 最適化本体と幾何の両方が要るので、まとめて再輸出する入口を作って束ねる。
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, `export * from ${JSON.stringify(join(viewer, "regCore"))};\n`
    + `export * from ${JSON.stringify(join(viewer, "regGeometry"))};\n`
    + `export * from ${JSON.stringify(join(viewer, "regDeformable"))};\n`);
  const outfile = join(dir, "engine.mjs");
  // Windows の .bin にあるのは拡張子なしのシェル用ラッパで、execFileSync からは起動できない。
  // 実行できるのは .cmd の方なので、プラットフォームで選ぶ。
  const esbuild = join(
    root,
    "frontend/node_modules/.bin",
    process.platform === "win32" ? "esbuild.cmd" : "esbuild",
  );
  execFileSync(esbuild, [entry, "--bundle", "--format=esm", "--platform=node", `--outfile=${outfile}`], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  // Windows の絶対パスはそのまま import できない（"c:" がスキーム扱いになる）。
  return import(pathToFileURL(outfile).href);
}

// ── main ─────────────────────────────────────────────────────────────────────

const truth = JSON.parse(readFileSync(truthPath, "utf8"));
const engine = await loadEngine();
const wanted = args.series.split(",").map((s) => s.trim()).filter(Boolean);

// 系列ディレクトリの接頭辞は真値 JSON から取る。ここを決め打ちにすると、
// ファントムが増えるたびにハーネスを二重化することになる。
const prefix = truth.phantom ?? "GNBP-2R";
// GNBP-2R の固定側は "fixed" という専用系列だが、GNBP-5N では 18 セルのうちの
// 1 つ（例 t20-id-tex）が固定側になる。既定は前者で、後者は --fixed で指定する。
const fixedKey = args.fixed ?? "fixed";
const fixedDir = join(args.phantom, `${prefix}-${fixedKey}`);
if (!existsSync(fixedDir)) {
  console.error(`fixed series not found: ${fixedDir}`);
  console.error(`  --fixed <key> で指定する。この真値に載っている系列: `
    + Object.keys(truth.series ?? {}).join(", "));
  exit(2);
}
const fixed = readSeries(fixedDir, engine.makeVolume);

const results = [];
for (const name of wanted) {
  const entry = truth.series?.[name];
  if (!entry) { console.error(`series "${name}" is not in the ground truth`); exit(2); }
  const moving = readSeries(join(args.phantom, `${prefix}-${name}`), engine.makeVolume);

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
  const scorer = resolve(fileURLToPath(new URL("./score_registration.mjs", import.meta.url)));
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

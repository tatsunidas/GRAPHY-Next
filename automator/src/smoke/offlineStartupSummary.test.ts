// 実行: cd automator && npx tsx --test src/smoke/offlineStartupSummary.test.ts
import test from "node:test";
import assert from "node:assert";
import { longestGaps, median, renderSummary, type StartupRun } from "./offlineStartupSummary.js";

const lines = [
  { t: 0.5, text: "[backend] starting" },
  { t: 1.0, text: "step: parts" },
  { t: 16.2, text: "step: database" },
  { t: 17.0, text: "ready" },
];

test("longestGaps: 最も長い間隔の前後の行が分かる", () => {
  const g = longestGaps(lines, 2);
  assert.strictEqual(g[0].gap.toFixed(1), "15.2");
  assert.strictEqual(g[0].after, "step: parts");
  assert.strictEqual(g[0].before, "step: database");
  assert.strictEqual(g[0].at, 1.0);
  assert.strictEqual(g.length, 2);
});

test("longestGaps: 負例 — 行が 0〜1 行なら空", () => {
  assert.deepStrictEqual(longestGaps([], 3), []);
  assert.deepStrictEqual(longestGaps([{ t: 1, text: "x" }], 3), []);
});

test("median: 偶数件は下側、空は null", () => {
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([4, 1, 3, 2]), 2);
  assert.strictEqual(median([]), null);
});

test("renderSummary: 待ちが見える表になる（時間切れ・未取得も崩れない）", () => {
  const runs: StartupRun[] = [
    { version: "v0.5.2", condition: "normal", index: 1, splashAt: 0.5, backendReadyAt: 6.2, mainAt: 6.6, timedOut: false, lines },
    { version: "v0.5.2", condition: "blocked", index: 1, splashAt: 0.5, backendReadyAt: 21.4, mainAt: 21.8, timedOut: false, lines },
    { version: "v0.5.2", condition: "blocked", index: 2, splashAt: null, backendReadyAt: null, mainAt: null, timedOut: true, lines: [] },
  ];
  const md = renderSummary(runs);
  assert.match(md, /\| v0\.5\.2 \| normal \| 1 \| 0\.5 \| 6\.2 \| 6\.6 \|/);
  assert.match(md, /15\.2 s @1\.0/);
  assert.match(md, /\(時間切れ\)|（時間切れ）/);
  assert.match(md, /\| v0\.5\.2 \| blocked \| 21\.4 \| 21\.8 \| 2 \|/); // 時間切れの回は中央値に入れない（件数は 2）
});

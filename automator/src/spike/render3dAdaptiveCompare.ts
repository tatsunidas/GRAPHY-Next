/*
 * 3D の操作中の縮小描画（描画環境 段 2）の速さの判定（A7）。
 * 設計: fw/render-environment-design.md §7.5
 *
 * 実行:  cd automator && npx tsx src/spike/render3dAdaptiveCompare.ts [<gpu>-<quality>]
 *   既定は sw-auto。RENDER3D_OUT の下の `new*-<gpu>-<quality>/result.json`（新）と `old*-…`（旧）を読む。
 *   新旧はそれぞれ render3dAdaptiveCheck.ts で、新は --label new1…、旧は導入前のコードで --baseline --label old1… として測っておく。
 *
 * 判定: ドラッグ開始から 2 秒のフレーム数（framesFirst2s）で、新の最小が旧の最大を上回れば合格。
 *   各 5 回に満たないとき・値が読めない回があるときは未達。
 */
import fs from "node:fs";
import path from "node:path";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const KEY = process.argv[2] ?? "sw-auto";
const OUT_ROOT = process.env.RENDER3D_OUT ?? path.join(AUTOMATOR_ROOT, ".results", "render-3d-adaptive");
const RUNS = 5;

function collect(prefix: "new" | "old"): { label: string; frames: number | null }[] {
  if (!fs.existsSync(OUT_ROOT)) return [];
  return fs
    .readdirSync(OUT_ROOT)
    .filter((d) => d.startsWith(prefix) && d.endsWith(`-${KEY}`))
    .sort()
    .map((d) => {
      const f = path.join(OUT_ROOT, d, "result.json");
      if (!fs.existsSync(f)) return { label: d, frames: null };
      const r = JSON.parse(fs.readFileSync(f, "utf-8")) as { framesFirst2s?: number };
      return { label: d, frames: typeof r.framesFirst2s === "number" ? r.framesFirst2s : null };
    });
}

const fresh = collect("new");
const old = collect("old");
for (const r of [...old, ...fresh]) console.log(`  ${r.label}: ${r.frames ?? "（読めない）"}`);

const ok = (xs: { frames: number | null }[]) => xs.length >= RUNS && xs.every((x) => x.frames !== null);
if (!ok(fresh) || !ok(old)) {
  console.log(`\n結果 (${KEY}): 未達 — 新 ${fresh.length} 回・旧 ${old.length} 回（各 ${RUNS} 回、全回の値が要る）`);
  process.exit(2);
}
const newMin = Math.min(...fresh.map((x) => x.frames as number));
const oldMax = Math.max(...old.map((x) => x.frames as number));
const pass = newMin > oldMax;
console.log(`\n新の最小 ${newMin} / 旧の最大 ${oldMax}`);
console.log(`結果 (${KEY}): ${pass ? "合格" : "失敗"} — A7 ドラッグ開始から 2 秒のフレーム数で、新の最小が旧の最大を上回る`);
process.exit(pass ? 0 : 1);

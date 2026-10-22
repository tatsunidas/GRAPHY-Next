/*
 * cornerstone の preScale が、スケール後の最小・最大が整数のとき整数型の配列に切り捨てる問題
 * （dicom-image-loader の decodeImageFrameWorker）が直っているかの実機検証（Chromium＋実 backend＋合成ファントム）。
 *
 * 実行:  cd automator && npx tsx src/spike/prescaleFloatCheck.ts [dev|build]
 *        dev   = vite dev サーバー（既定）
 *        build = `vite build` した dist を静的配信（worker.plugins の抜けは本番ビルドだけで出るため）
 *
 * ファントムは元の make-fusion-isoline-phantom.py（PT の RescaleSlope 0.5、スケール後の最小・最大が整数になる）。
 * PT を単独で開き、カーソル位置の読み値を、保管庫の DICOM を pydicom で読んだ stored × slope と突き合わせる。
 * 修正前は、半整数（694.5 など）が切り捨てられて整数で読める。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { WebDriver } from "../driver/webDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "prescale-float-check");
const PHANTOM_DIR = path.join(OUT_DIR, "phantom");
const STORE_DIR = path.join(AUTOMATOR_ROOT, ".results", "run-data", "web");
const { check, summary } = createChecker();
const py = process.env.GRAPHY_TEST_PYTHON ?? "python3";

function sample(x: string, y: string): number[][] {
  const r = spawnSync(py, ["-I", path.join(AUTOMATOR_ROOT, "scripts", "verify-fusion-calc-output.py"),
    STORE_DIR, PHANTOM_DIR, "PT foreground", `sampleall:${x}:${y}`], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`verify failed: ${r.stderr}`);
  return JSON.parse(r.stdout).neigh_all;
}

async function main(): Promise<void> {
  const mode = process.argv[2] === "build" ? "build" : "dev";
  if (mode === "build") process.env.GRAPHY_FRONTEND_MODE = "preview"; // WebDriver が `vite preview`（dist）を起動する
  const gen = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", "make-fusion-isoline-phantom.py"), PHANTOM_DIR], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`ファントムを作れませんでした: ${gen.stderr}`);

  const d = new WebDriver({ http: 18640, scp: 18641, vite: 18643 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    await resetDb(d.ports.http);
    await importPaths(d.ports.http, [PHANTOM_DIR]);
    await d.page.reload();
    await d.page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await d.page.getByTestId("search-allperiod-chip").click();
    await d.page.getByTestId("search-submit-button").click();
    await d.page.locator('[data-testid^="study-row-"]').first().click();
    await d.page.locator('[data-testid^="series-row-"]').filter({ hasText: /PT foreground/ }).first().click();
    await d.page.waitForTimeout(2500);
    const v = await d.waitForNewPage(() => d.page.getByTestId("viewer2d-toolbar-button").click(), () => true, 30_000);
    await v.setViewportSize({ width: 1400, height: 900 });
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await v.waitForTimeout(3000);
    const tile = v.getByTestId("series-viewer-root").first();
    const box = (await tile.boundingBox())!;

    // 球の中心のスライス（z = 0 は 21 枚の 11 枚目）へ。先頭スライスは背景値だけで、検査対象が無い。
    await v.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 10; i++) { await v.mouse.wheel(0, 100); await v.waitForTimeout(250); }
    await v.waitForTimeout(1200);

    console.log(`\n[${mode}] slope 0.5 の PT の読み値 ＝ stored × 0.5（半整数が切り捨てられない）`);
    let matched = 0, fractional = 0, total = 0;
    for (const [fx, fy] of [[0.5, 0.4], [0.48, 0.4], [0.52, 0.4], [0.5, 0.38], [0.5, 0.42], [0.53, 0.43], [0.47, 0.37], [0.515, 0.375]] as const) {
      const px = box.x + box.width * fx, py_ = box.y + box.height * fy;
      await v.mouse.move(px + 5, py_ + 5);
      await v.mouse.move(px, py_);
      await v.waitForTimeout(600);
      const body = await v.locator("body").innerText();
      const xy = /XY\s+(-?[\d.]+),\s*(-?[\d.]+)/.exec(body);
      const z = /Z\s+(\d+)\/(\d+)/.exec(body);
      const text = (await v.getByTestId("status-value").first().innerText()).trim();
      const shown = parseFloat(text);
      if (!xy || !z || !Number.isFinite(shown)) { check(false, "XY・Z・値が読める", { text, xy: xy?.[0], z: z?.[0] }); continue; }
      const neigh = sample(xy[1], xy[2])[Number(z[1]) - 1];
      const ok = neigh.some((n) => Math.abs(n - shown) < 0.06);
      total++;
      if (ok) matched++;
      if (neigh.some((n) => Math.abs(n - Math.round(n)) > 0.4)) fractional++;
      console.log(`  (${fx}, ${fy}) Z=${z[1]} XY=${xy[1]},${xy[2]} 読み値=${text} / 保存値の近傍=${neigh.map((n) => n.toFixed(1)).join(" ")}`);
    }
    check(total >= 6, "読めた点が 6 点以上", total);
    check(fractional >= 3, "検査対象に半整数の画素が含まれる（切り捨てが起きれば差が出る状況）", fractional);
    check(matched === total, "全点で読み値が保存値（stored × 0.5）と一致", { matched, total });
    await v.screenshot({ path: path.join(OUT_DIR, `${mode}-pt.png`) });
  } finally {
    await d.stop();
  }
}

main()
  .then(() => process.exit(summary() === 0 ? 0 : 1))
  .catch((e) => {
    console.error(e);
    process.exit(2);
  });

/*
 * 再格子化（fw/volume-regrid-design.md）の実機照合。合成 CT（斜位・ガントリチルト）を取り込み、
 * 2D ビューアの 画像 > リサンプル・切り抜き… を**実際に押して**等方 1.0 mm で保存し、
 * 新しいシリーズのヘッダと値を python 側の真値（リサンプラの実装に依らない）と照合する。
 *
 * 実行:  cd automator && npx tsx src/spike/regridCheck.ts
 *        （ファントム生成と照合に numpy・pydicom のある Python が要る: GRAPHY_TEST_PYTHON、既定は python）
 *
 * 未実施の項目（材料不足）: SUV 校正中の PET、見積りが上限を超えたときの確認とキャンセル、600 枚級の送信。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "regrid-check");
const PHANTOM_DIR = path.join(OUT_DIR, "phantom");
const { check, summary } = createChecker();
const S = 1.0;

interface Truth {
  slices: number;
  phantoms: Array<{ studyUid: string; seriesUid: string; dir: string }>;
}

async function getJson<T>(http: number, p: string): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${http}${p}`);
  if (!res.ok) throw new Error(`${p}: ${res.status}`);
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const py = process.env.GRAPHY_TEST_PYTHON ?? "python";
  const gen = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", "make-regrid-phantom.py"), PHANTOM_DIR], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`ファントムを作れませんでした: ${gen.stderr}`);
  const truthPath = path.join(PHANTOM_DIR, "truth.json");
  const truth = JSON.parse(fs.readFileSync(truthPath, "utf8")) as Truth;
  fs.renameSync(truthPath, path.join(OUT_DIR, "truth.json"));

  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    const http = driver.ports.http;
    page.on("dialog", (d) => void d.accept());
    await resetDb(http);
    await importPaths(http, [PHANTOM_DIR]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();

    for (const ph of truth.phantoms) {
      console.log(`\n[${ph.dir}] 2D ビューアでリサンプル → 保存 → 照合`);
      await page.locator(`[data-testid="study-row-${ph.studyUid}"]`).click();
      await page.locator(`[data-testid="series-row-${ph.seriesUid}"]`).click();
      const viewer = await driver.waitForNewPage(
        () => page.getByTestId("viewer2d-toolbar-button").click(),
        (url) => url.includes("2dviewer"),
      );
      await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
      await viewer.waitForTimeout(2_000);
      viewer.on("dialog", (d) => void d.accept());

      await viewer.getByTestId("viewer2d-menu-image").click();
      await viewer.getByTestId("menu-resample").click();
      await viewer.getByTestId("resample-dialog").waitFor({ state: "visible", timeout: 10_000 });
      await viewer.getByTestId("resample-source").filter({ hasText: "×" }).waitFor({ timeout: 60_000 });
      check(/64×48×40/.test((await viewer.getByTestId("resample-source").textContent()) ?? ""), "ダイアログに元の格子（64×48×40）が出る");
      await viewer.getByTestId("resample-iso").fill(String(S));
      check(await viewer.getByTestId("resample-save").isEnabled(), "1.0 mm で [保存] が押せる");
      await viewer.getByTestId("resample-iso").fill("0");
      check(!(await viewer.getByTestId("resample-save").isEnabled()), "【負例】間隔 0 では [保存] が押せない");
      await viewer.getByTestId("resample-iso").fill("");
      check(!(await viewer.getByTestId("resample-save").isEnabled()), "【負例】間隔が空では [保存] が押せない");
      await viewer.getByTestId("resample-iso").fill(String(S));
      await viewer.getByTestId("resample-save").click();
      await viewer.getByTestId("resample-message").filter({ hasText: /\d/ }).waitFor({ timeout: 120_000 });
      const message = (await viewer.getByTestId("resample-message").textContent()) ?? "";
      check(!/失敗|failed/i.test(message), "保存が成功する", message);
      await viewer.screenshot({ path: path.join(OUT_DIR, `${ph.dir}-dialog.png`) });
      await viewer.close();

      // 新しいシリーズ（元と別の UID）を backend から読む
      const list = await getJson<Array<{ seriesInstanceUid: string }>>(http, `/api/studies/${ph.studyUid}/series`);
      const derived = list.filter((s) => s.seriesInstanceUid !== ph.seriesUid);
      check(derived.length === 1, "新しいシリーズが 1 本できる", derived.length);
      const orig = await getJson<unknown[]>(http, `/api/studies/${ph.studyUid}/series/${ph.seriesUid}/instances`);
      check(orig.length === truth.slices, "元のシリーズの枚数が変わらない", orig.length);
      if (derived.length !== 1) continue;
      const dsUid = derived[0].seriesInstanceUid;
      const inst = await getJson<Array<{ sopInstanceUid: string }>>(http, `/api/studies/${ph.studyUid}/series/${dsUid}/instances`);
      const dir = path.join(OUT_DIR, `${ph.dir}-derived`);
      fs.mkdirSync(dir, { recursive: true });
      for (const [n, i] of inst.entries()) {
        const res = await fetch(`http://127.0.0.1:${http}/api/studies/${ph.studyUid}/series/${dsUid}/instances/${i.sopInstanceUid}/file`);
        fs.writeFileSync(path.join(dir, `o${String(n).padStart(4, "0")}.dcm`), Buffer.from(await res.arrayBuffer()));
      }
      const ver = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", "verify-regrid-output.py"), path.join(OUT_DIR, "truth.json"), ph.dir, dir, String(S)], { encoding: "utf8" });
      if (ver.status !== 0) { check(false, "照合スクリプトが動く", ver.stderr); continue; }
      const r = JSON.parse(ver.stdout) as { checks: Array<[string, boolean, string]>; padded: number };
      for (const [name, ok, detail] of r.checks) check(ok, name, detail);
      if (ph.dir === "oblique") check(r.padded === 0, "斜位: PixelPaddingValue の画素が 0 個", r.padded);
      else console.log(`    チルト: 余白（元の範囲外）の画素 ${r.padded} 個（報告のみ。有限値の画素だけを照合）`);
    }
  } finally {
    await driver.stop();
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/*
 * AI 系プラグインを「解析 ＞ AI ▸」に束ねる（plugin.json の category）。設計: fw/plugin-architecture.md §2.1.1。
 *
 * 実行:  cd automator && npx tsx src/spike/pluginAiMenuCheck.ts
 *
 * 計算機（Colab）は使わない。公式プラグイン vis-monai の ui.js を、manifest だけ変えて 4 通りに入れる:
 *   vis-monai            … category "ai"・解析に宣言           → AI の中
 *   ai-menu-probe-both   … category "ai"・プラグインと解析の両方 → AI の中に 1 回だけ。プラグインメニューには出ない
 *   ai-menu-probe-flat   … category 無し・解析に宣言           → 解析に平置き（今までどおり）
 *   ai-menu-probe-odd    … 未知の category "games"             → 解析に平置き
 * 最後に AI の中から vis-monai を起動し、窓が開くことを見る。サブメニューはスクリーンショットで目視する。
 */
import fs from "node:fs";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "plugin-ai-menu-check");
const PLUGINS_DIR = path.join(DESKTOP_RUN_DATA_DIR, "plugins");
const PROBES = ["ai-menu-probe-both", "ai-menu-probe-flat", "ai-menu-probe-odd"];
const { check, summary } = createChecker();

function install(id: string, name: string, contributes: string[], category: string | undefined): void {
  const src = process.env.GRAPHY_MONAI_PLUGIN_DIR ?? path.join(AUTOMATOR_ROOT, "..", "..", "graphy-workspace", "graphy-next-plugin-monai");
  if (!fs.existsSync(path.join(src, "ui.js"))) throw new Error(`公式プラグインの作業コピーがありません: ${src}（GRAPHY_MONAI_PLUGIN_DIR で指定）`);
  const dst = path.join(PLUGINS_DIR, id);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(src, "plugin.json"), "utf8"));
  Object.assign(manifest, { id, name, contributes, engines: { ...manifest.engines, graphy: ">=0.0.0" } });
  if (category === undefined) delete manifest.category;
  else manifest.category = category;
  fs.writeFileSync(path.join(dst, "plugin.json"), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(src, "ui.js"), path.join(dst, "ui.js"));
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  install("vis-monai", "MONAI Bundle (remote GPU)", ["viewer2d.menu.analysis"], "ai");
  install("ai-menu-probe-both", "Probe both", ["viewer2d.menu", "viewer2d.menu.analysis"], "ai");
  install("ai-menu-probe-flat", "Probe flat", ["viewer2d.menu.analysis"], undefined);
  install("ai-menu-probe-odd", "Probe odd", ["viewer2d.menu.analysis"], "games");

  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });

    // backend が配る manifest（前提: 4 つとも読み込まれ、category が期待どおり）
    const base = `http://localhost:${driver.ports.http}`;
    const res = await fetch(`${base}/api/plugins`);
    check(res.ok, "GET /api/plugins が 2xx", String(res.status));
    const manifests = (await res.json()) as { id: string; category?: string }[];
    const cat = (id: string) => manifests.find((m) => m.id === id);
    check(["vis-monai", ...PROBES].every((id) => cat(id)), "4 つとも読み込まれた", manifests.map((m) => m.id).join(","));
    check(cat("vis-monai")?.category === "ai" && cat("ai-menu-probe-both")?.category === "ai"
        && cat("ai-menu-probe-flat")?.category === undefined && cat("ai-menu-probe-odd")?.category === undefined, "category: vis-monai=ai・both=ai・flat なし・odd（未知）なし", JSON.stringify(manifests.map((m) => [m.id, m.category ?? null])));

    await dismissStartupDialogs(page);
    const study = ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[])[0];
    const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; modality: string }[];
    const ct = series.find((s) => s.modality === "CT")!;
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${study.studyInstanceUid}"]`).click();
    await page.locator(`[data-testid="series-row-${ct.seriesInstanceUid}"]`).click();
    const viewer = await driver.waitForNewPage(
      () => page.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(2_000);

    // 解析メニュー: 平置きは flat・odd だけ、AI は 1 項目
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    const count = (id: string) => viewer.locator(`[data-testid="${id}"]`).count();
    check((await count("plugin-analysis-item-ai-menu-probe-flat")) === 1 && (await count("plugin-analysis-item-ai-menu-probe-odd")) === 1, "解析に平置き: flat・odd がある");
    check((await count("plugin-analysis-item-vis-monai")) === 0 && (await count("plugin-analysis-item-ai-menu-probe-both")) === 0, "解析に平置き: vis-monai・both は無い");
    check((await count("viewer2d-menu-ai")) === 1, "AI のサブメニューが 1 つある");
    await viewer.getByTestId("viewer2d-menu-ai").hover();
    await viewer.getByTestId("plugin-ai-item-vis-monai").waitFor({ state: "visible", timeout: 5_000 });
    check((await count("plugin-ai-item-vis-monai")) === 1 && (await count("plugin-ai-item-ai-menu-probe-both")) === 1, "AI の中: vis-monai と both が 1 回ずつ");
    check((await count("plugin-ai-item-ai-menu-probe-flat")) === 0 && (await count("plugin-ai-item-ai-menu-probe-odd")) === 0, "AI の中: flat・odd は無い");
    await viewer.screenshot({ path: path.join(OUT_DIR, "analysis-ai-submenu.png") });

    // プラグインメニュー: both（AI）は出ない
    await viewer.mouse.click(5, 5);
    await viewer.getByTestId("viewer2d-menu-plugins").click();
    check((await count("plugin-item-ai-menu-probe-both")) === 0, "プラグインメニューに both（AI）は出ない");
    await viewer.screenshot({ path: path.join(OUT_DIR, "plugins-menu.png") });
    // AI の中から起動できる
    await viewer.mouse.click(5, 5);
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    await viewer.getByTestId("viewer2d-menu-ai").hover();
    await viewer.getByTestId("plugin-ai-item-vis-monai").click();
    const opened = await viewer.getByTestId("monai-bundle").waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
    check(opened, "AI の中から vis-monai の窓が開く");
    await viewer.screenshot({ path: path.join(OUT_DIR, "monai-opened.png") });

  } finally {
    await driver.stop();
    for (const id of [...PROBES, "vis-monai"]) fs.rmSync(path.join(PLUGINS_DIR, id), { recursive: true, force: true });
  }
  process.exitCode = summary() === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

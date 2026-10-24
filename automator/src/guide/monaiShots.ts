/*
 * ユーザーグループ向け「MONAI の使い方」PDF の画面を撮る（docs/user-guides/monai/shots/ と marks.js）。
 * 本文は docs/user-guides/monai/guide.html、PDF にするのは monaiPdf.ts。
 *
 * 実行（Linux・Electron 版。専用ポートで 1 本だけ起動する）:
 *   cd automator
 *   GRAPHY_AUTOMATOR_HTTP_PORT=18890 GRAPHY_AUTOMATOR_SCP_PORT=18891 GRAPHY_AUTOMATOR_VITE_PORT=18893 \
 *     npx tsx src/guide/monaiShots.ts colab
 *   GRAPHY_MONAI_PYBIN=<jupyter_server・ipykernel・numpy だけの venv の bin> \
 *   GRAPHY_AUTOMATOR_HTTP_PORT=18890 ... npx tsx src/guide/monaiShots.ts env
 *
 * colab: Colab の GPU T4 で脾臓 CT を 1 本通し、設定・実行・同意・結果・SEG 保存・解放の画面を撮る。
 *        🔴 Colab にログイン済みであること（computeColabCheck を一度通してある）。利用者の Colab の枠を数分使い、最後に解放する。
 * env:   依存の無い Python の「この PC」で、事前チェックの枠（不足の表・導入コマンド）を撮る。推論は走らせない。
 *
 * 🔴 写り込み: Google アカウントのメールアドレスはぼかす。患者は TCIA HCC-TACE-Seg のデモデータだけ。
 */
import fs from "node:fs";
import path from "node:path";

import type { Locator, Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { installOfficialPlugin, openViewer, state } from "../spike/computeMonaiShared.js";
import { consentWindow } from "../spike/computeSpikeShared.js";
import type { Mark } from "./run.js";

const SHOTS = path.resolve(AUTOMATOR_ROOT, "..", "docs", "user-guides", "monai", "shots");
const MARKS_FILE = path.join(SHOTS, "marks.js");

type Target = Locator | { at: Locator; side: Mark["side"] };

function loadMarks(): Record<string, unknown> {
  if (!fs.existsSync(MARKS_FILE)) return {};
  const text = fs.readFileSync(MARKS_FILE, "utf8");
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}
const marks = loadMarks();

async function shot(page: Page, name: string, targets: Target[] = []): Promise<void> {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const vp = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const boxes: Mark[] = [];
  for (const t of targets) {
    const { at, side } = "at" in t ? t : { at: t, side: "top" as const };
    const b = await at.boundingBox();
    if (!b) throw new Error(`${name}: 番号を振る要素が画面にありません: ${at}`);
    const x0 = Math.max(0, b.x), y0 = Math.max(0, b.y);
    const x1 = Math.min(vp.width, b.x + b.width), y1 = Math.min(vp.height, b.y + b.height);
    boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, side });
  }
  marks[name] = { width: vp.width, height: vp.height, marks: boxes };
  fs.writeFileSync(MARKS_FILE, `window.GUIDE_MARKS = ${JSON.stringify(marks, null, 2)};\n`);
  console.log(`撮影: ${name}.png（番号 ${boxes.length}）`);
}

/** 画面は小さめ（1280×720）に撮り、画素は 2 倍で持つ。縮小して載せても文字が読める。 */
async function fit(page: Page, width = 1280, height = 720): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(800);
}

/** 画面を 1280×720 にしたあと、プラグインの窓を画面に収める（窓は作られたときの大きさ・位置のまま）。 */
async function fitPluginWindow(viewer: Page): Promise<void> {
  await viewer.evaluate(() => {
    const w = document.querySelector<HTMLElement>(".graphy-plugin-window");
    if (!w) return;
    w.style.height = `${window.innerHeight - 40}px`;
    w.style.top = "20px";
    w.style.left = `${Math.max(0, Math.round((window.innerWidth - w.offsetWidth) / 2))}px`;
  });
  await viewer.waitForTimeout(500);
}

/** HOME より上のパス（利用者名を含む）を「…」にする。画面の文字だけで、データは変えない。 */
async function hidePaths(page: Page): Promise<void> {
  await page.evaluate((roots) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      for (const r of roots) if (r && n.textContent?.includes(r)) n.textContent = n.textContent.split(r).join("…");
    }
  }, [process.env.HOME ?? "", process.env.GRAPHY_MONAI_PYBIN ? path.dirname(process.env.GRAPHY_MONAI_PYBIN) : ""]);
}

/** Google アカウントのメールアドレスは載せない（ぼかす）。 */
async function blurAccount(page: Page): Promise<void> {
  await page.addStyleTag({ content: '[data-testid="compute-colab-account"] { filter: blur(7px); }' });
}

async function waitIdle(viewer: Page, timeoutMs: number): Promise<void> {
  await viewer.waitForFunction(() => (window as unknown as { __monaiState?: { phase: string } }).__monaiState?.phase === "idle", null, { timeout: timeoutMs });
}

async function prepare(driver: DesktopDriver): Promise<{ page: Page; study: { studyInstanceUid: string }; ctUid: string }> {
  const page = driver.page;
  page.on("dialog", (d) => void d.accept());
  await resetDb(driver.ports.http);
  await importPaths(driver.ports.http, [path.join(process.env.GRAPHY_GUIDE_DATA ?? path.join(process.env.HOME ?? "", "graphy-demo-samples"), "HCC_001")]);
  await page.evaluate(() => localStorage.setItem("graphy.locale", "ja"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await fit(page);
  await driver.app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
  });
  const base = `http://localhost:${driver.ports.http}`;
  const study = ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[])[0];
  const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as {
    seriesInstanceUid: string; modality: string; numberOfInstances: number; seriesDescription?: string;
  }[];
  const cts = series.filter((s) => s.modality === "CT");
  // C-A-P は撮影 2 回ぶんが同じ位置で重なって npz にできない。間隔の揃った PRE LIVER を使う
  const ct = cts.find((s) => /LIVER/i.test(s.seriesDescription ?? "")) ?? cts.sort((a, b) => b.numberOfInstances - a.numberOfInstances)[0];
  return { page, study, ctUid: ct.seriesInstanceUid };
}

async function openSettingsCompute(page: Page): Promise<void> {
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-cat-compute").click();
  await page.getByTestId("compute-panel").waitFor({ state: "visible", timeout: 20_000 });
}

async function colab(): Promise<void> {
  installOfficialPlugin();
  // 同意画面（別窓）の言語は OS の言語に従うので、日本語で撮る
  const driver = new DesktopDriver({}, { extraElectronArgs: ["--lang=ja"], extraEnv: { LANGUAGE: "ja", LC_ALL: "ja_JP.UTF-8", LANG: "ja_JP.UTF-8" } });
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  const endpointId = "colab-t4";
  try {
    await driver.start();
    const { page, study, ctUid } = await prepare(driver);
    const cwd = await driver.app.evaluate(() => process.cwd());
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    if (endpointsBackup !== null) fs.rmSync(endpointsFile);

    // ── 1. 設定 ＞ 外部の計算機（Colab） ──
    await openSettingsCompute(page);
    await page.getByTestId("compute-colab").waitFor({ state: "visible", timeout: 10_000 });
    if ((await page.getByTestId("compute-colab-account").count()) === 0) {
      throw new Error("Colab にログインしていません（computeColabCheck を一度通してください）");
    }
    await blurAccount(page);
    await page.getByTestId("compute-colab-spec").selectOption("VARIANT_GPU/T4/SHAPE_STANDARD");
    await page.getByTestId("compute-colab-add").click();
    await page.getByTestId(`compute-endpoint-${endpointId}`).waitFor({ state: "visible", timeout: 10_000 });
    // 追加の処理中はボタンが灰色になる。有効に戻ってから撮る
    await page.waitForFunction(() => !(document.querySelector('[data-testid="compute-colab-add"]') as HTMLButtonElement | null)?.disabled, null, { timeout: 30_000 });
    await page.waitForTimeout(800);
    // 画面下の計算ジョブの集計（過去の検証の「失敗」が残っていると、案内に紛れる）は隠す
    await page.evaluate(() => {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        if (el.children.length === 0 && /^計算: 実行中/.test(el.textContent ?? "")) el.style.visibility = "hidden";
      }
    });
    await shot(page, "settings-colab", [
      { at: page.getByTestId("compute-colab-account"), side: "left" },
      { at: page.getByTestId("compute-colab-spec"), side: "left" },
      { at: page.getByTestId("compute-colab-add"), side: "left" },
      { at: page.getByTestId(`compute-endpoint-${endpointId}`), side: "left" },
    ]);
    await page.getByTestId("dialog-close-button").click();

    // ── 2. 2D ビューアでプラグインを起動 ──
    await dismissStartupDialogs(page);
    const viewer = await openViewer(driver, page, study.studyInstanceUid, ctUid);
    await fit(viewer);
    await fitPluginWindow(viewer);
    await viewer.getByTestId("monai-bundle").selectOption("spleen_ct_segmentation");
    await viewer.waitForTimeout(1_000);
    await shot(viewer, "plugin-window", [
      { at: viewer.getByTestId("monai-bundle"), side: "left" },
      { at: viewer.getByTestId("monai-version"), side: "left" },
      { at: viewer.getByTestId("monai-run"), side: "left" },
    ]);

    // ── 3. 実行 → 事前チェック（Colab は通る）→ 本処理の同意画面 ──
    await viewer.getByTestId("monai-run").click();
    const pw = await consentWindow(driver, 300_000);
    await pw.getByTestId("consent-ack").check();
    await pw.getByTestId("consent-send").click();
    const w = await consentWindow(driver, 300_000);
    // 送り先の URL は Colab のセッション固有のホスト名なので、ぼかす（宛先の名前「Colab GPU T4」は残る）
    await w.addStyleTag({ content: '[data-testid="consent-url"] { filter: blur(6px); }' });
    await w.waitForTimeout(800);
    await shot(w, "consent", [
      { at: w.getByTestId("consent-url"), side: "left" },
      { at: w.getByTestId("consent-datasets"), side: "left" },
      { at: w.getByTestId("consent-code"), side: "left" },
      { at: w.getByTestId("consent-ack"), side: "left" },
    ]);
    await w.getByTestId("consent-ack").check();
    await w.getByTestId("consent-send").click();
    await waitIdle(viewer, 3_600_000);
    const s = await state(viewer);
    if (!s.summary || s.error) throw new Error(`実行に失敗しました: ${s.error}`);
    await viewer.waitForTimeout(2_500);

    // ── 4. 結果 ──
    await shot(viewer, "result", [
      { at: viewer.getByTestId("monai-result"), side: "left" },
      { at: viewer.getByTestId("monai-preview"), side: "left" },
      { at: viewer.getByTestId("monai-save"), side: "left" },
    ]);

    // ── 4b. ROI マネージャ（結果のラベルが読み込まれている）。プラグインの窓は一旦隠して撮る ──
    await viewer.evaluate(() => { (document.querySelector(".graphy-plugin-window") as HTMLElement).style.visibility = "hidden"; });
    try {
      await viewer.getByTestId("viewer2d-menu-roiTools").click();
      await viewer.getByText("ROI マネージャ", { exact: true }).first().click();
      const title = viewer.locator("strong", { hasText: "ROI マネージャ" }).first();
      await title.waitFor({ state: "visible", timeout: 20_000 });
      await viewer.waitForTimeout(1_000);
      const targets: Target[] = [{ at: title, side: "top" }];
      if ((await viewer.getByTestId("roi-mgr-row").count()) > 0) targets.push({ at: viewer.getByTestId("roi-mgr-row").first(), side: "left" });
      if (await viewer.getByTestId("roi-mgr-save").isVisible().catch(() => false)) targets.push({ at: viewer.getByTestId("roi-mgr-save"), side: "left" });
      await shot(viewer, "roi-manager", targets);
    } catch (e) {
      await viewer.screenshot({ path: path.join(SHOTS, "debug-roi-manager.png") });
      console.log(`ROI マネージャの撮影に失敗（続行）: ${String(e).slice(0, 160)}`);
    }
    await viewer.evaluate(() => { (document.querySelector(".graphy-plugin-window") as HTMLElement).style.visibility = "visible"; });

    // ── 5. SEG で保存 ──
    await viewer.getByTestId("monai-save").click();
    await viewer.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 60_000 });
    await viewer.waitForTimeout(800);
    await shot(viewer, "save-confirm", [{ at: viewer.getByTestId("plugin-save-confirm-button"), side: "left" }]);
    await viewer.getByTestId("plugin-save-confirm-button").click();
    await viewer.waitForFunction(() => !!(window as unknown as { __monaiState?: { saved?: unknown } }).__monaiState?.saved, null, { timeout: 300_000 });
    await viewer.waitForTimeout(1_500);
    await shot(viewer, "saved");

    // ── 6. 閉じて解放 ──
    await viewer.locator(".graphy-plugin-window__close").click();
    await viewer.getByTestId("compute-release-confirm").waitFor({ state: "visible", timeout: 30_000 });
    await shot(viewer, "release-confirm", [{ at: viewer.getByTestId("compute-release-ok"), side: "left" }]);
    await viewer.getByTestId("compute-release-ok").click();
    await viewer.waitForFunction(() => !!(window as unknown as { __monaiState?: { release?: unknown } }).__monaiState?.release, null, { timeout: 120_000 });
  } finally {
    await driver.page.evaluate((id) => (window as unknown as { graphyDesktop: any }).graphyDesktop.computeColabRelease(id), endpointId).catch(() => undefined);
    await driver.stop();
    if (endpointsFile) {
      if (endpointsBackup !== null) fs.writeFileSync(endpointsFile, endpointsBackup);
      else fs.rmSync(endpointsFile, { force: true });
    }
  }
}

async function env(): Promise<void> {
  const bin = process.env.GRAPHY_MONAI_PYBIN;
  if (!bin || !fs.existsSync(path.join(bin, "python"))) throw new Error("GRAPHY_MONAI_PYBIN に venv の bin を指定してください");
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  installOfficialPlugin();
  // 同意画面（別窓）の言語は OS の言語に従うので、日本語で撮る
  const driver = new DesktopDriver({}, { extraElectronArgs: ["--lang=ja"], extraEnv: { LANGUAGE: "ja", LC_ALL: "ja_JP.UTF-8", LANG: "ja_JP.UTF-8" } });
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  try {
    await driver.start();
    const { page, study, ctUid } = await prepare(driver);
    const cwd = await driver.app.evaluate(() => process.cwd());
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    await page.evaluate(() => (window as unknown as { graphyDesktop: { computeDefaultSet: (id: string) => Promise<unknown> } }).graphyDesktop.computeDefaultSet("local"));

    // 設定 ＞ 外部の計算機（この PC）
    await openSettingsCompute(page);
    const local = page.getByTestId("compute-local");
    await local.waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("compute-local-detect").click();
    await page.getByTestId("compute-local-headline").waitFor({ state: "visible", timeout: 120_000 });
    await page.waitForTimeout(1_500);
    // Python のパスは利用者名を含むので、写さない
    await page.addStyleTag({ content: '[data-testid="compute-local-python"], [data-testid^="compute-local-candidate"] { filter: blur(7px); }' });
    await local.scrollIntoViewIfNeeded();
    await hidePaths(page);
    await shot(page, "settings-local", [
      { at: page.getByTestId("compute-local-headline"), side: "left" },
      { at: page.getByTestId("compute-local-detect"), side: "left" },
    ]);
    await page.getByTestId("dialog-close-button").click();

    await dismissStartupDialogs(page);
    await page.getByTestId("search-allperiod-chip").click();
    const viewer = await openViewer(driver, page, study.studyInstanceUid, ctUid);
    await fit(viewer);
    await fitPluginWindow(viewer);
    await viewer.getByTestId("monai-bundle").selectOption("spleen_ct_segmentation");
    await viewer.getByTestId("monai-run").click();
    const pw = await consentWindow(driver, 120_000);
    await pw.screenshot({ path: path.join(SHOTS, "debug-consent-probe.png") });
    await pw.getByTestId("consent-ack").check();
    await pw.getByTestId("consent-send").click();
    await viewer.getByTestId("monai-env").waitFor({ state: "visible", timeout: 120_000 });
    // 使われる Python のパスは利用者名を含むので、ぼかす
    await hidePaths(viewer);
    await viewer.addStyleTag({ content: '[data-testid="monai-env-python"], [data-testid="monai-env-command"] { filter: blur(6px); }' });
    await viewer.waitForTimeout(500);
    await shot(viewer, "env-panel", [
      { at: viewer.getByTestId("monai-env"), side: "left" },
      { at: viewer.getByTestId("monai-env-command"), side: "left" },
      { at: viewer.getByTestId("monai-env-recheck"), side: "left" },
    ]);
  } finally {
    await driver.stop();
    if (endpointsFile) {
      if (endpointsBackup !== null) fs.writeFileSync(endpointsFile, endpointsBackup);
      else fs.rmSync(endpointsFile, { force: true });
    }
  }
}

fs.mkdirSync(SHOTS, { recursive: true });
const mode = process.argv[2];
if (mode === "colab") await colab();
else if (mode === "env") await env();
else {
  console.error("使い方: monaiShots.ts colab | env");
  process.exit(2);
}

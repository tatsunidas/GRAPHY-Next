/*
 * 「この PC」の計算機: 起動したまま Jupyter などを後から入れても、本体を再起動せずに通ることの実機検証。
 *
 * 実行:  cd automator && GRAPHY_RETRY_BARE=<Jupyter も何も入っていない venv の bin> \
 *          GRAPHY_RETRY_SITES=<Jupyter Server・ipykernel の入った venv の site-packages（: 区切り）> \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=18890 GRAPHY_AUTOMATOR_SCP_PORT=18891 GRAPHY_AUTOMATOR_VITE_PORT=18893 \
 *          npx tsx src/spike/computeLocalRetryCheck.ts
 *   1. 「この PC」の Python を、何も入っていない venv に固定して起動する（compute-endpoints.json を書く）
 *   2. MONAI プラグインの「実行」→ local-unavailable（Jupyter が無い。失敗側。操作が効いていることの確認）
 *   3. 本体は再起動せず、.pth で Jupyter 等の入った site-packages を見せる（「後から入れた」の再現）
 *   4. もう一度「実行」→ 事前チェックの同意画面まで進む（修正前のコードでは local-unavailable のまま）
 *
 * 🔴 compute-endpoints.json（既定の計算機・Python の指定）を書き換えるので、終わったら元へ戻す。
 * 修正の前後を比べるときは、同じ手順を旧コードの作業コピーでも走らせる（旧コードでは 4 が落ちるのが正しい）。
 */
import fs from "node:fs";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { installOfficialPlugin, openViewer, state } from "./computeMonaiShared.js";
import { consentWindow, createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-local-retry-check");
const { check, summary } = createChecker();
const DESKTOP_DIR = path.resolve(AUTOMATOR_ROOT, "..", "desktop");
const ENDPOINTS = path.join(DESKTOP_DIR, "compute-endpoints.json");

const sitePackages = (bin: string): string => {
  const lib = path.join(bin, "..", "lib");
  const py = fs.readdirSync(lib).find((d) => d.startsWith("python"));
  if (!py) throw new Error(`site-packages がありません: ${lib}`);
  return path.join(lib, py, "site-packages");
};

async function main(): Promise<void> {
  const bare = process.env.GRAPHY_RETRY_BARE;
  const sites = (process.env.GRAPHY_RETRY_SITES ?? "").split(path.delimiter).filter(Boolean);
  if (!bare || !fs.existsSync(path.join(bare, "python"))) throw new Error("GRAPHY_RETRY_BARE に venv の bin を指定してください");
  if (sites.length === 0) throw new Error("GRAPHY_RETRY_SITES に Jupyter 等の入った site-packages を指定してください");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installOfficialPlugin();

  const backup = fs.existsSync(ENDPOINTS) ? fs.readFileSync(ENDPOINTS, "utf8") : null;
  const pth = path.join(sitePackages(bare), "zz-installed.pth");
  fs.rmSync(pth, { force: true });
  // 「この PC」の Python を何も入っていない venv に固定し、既定の計算機を「この PC」にする
  fs.writeFileSync(
    ENDPOINTS,
    JSON.stringify({ schemaVersion: 2, endpoints: [], local: { python: { mode: "path", path: path.join(bare, "python") } }, defaultId: "local" }, null, 2),
    { mode: 0o600 },
  );
  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    await importPaths(driver.ports.http, [path.join(process.env.GRAPHY_GUIDE_DATA ?? path.join(process.env.HOME ?? "", "graphy-demo-samples"), "HCC_001")]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
    });
    const base = `http://localhost:${driver.ports.http}`;
    const study = ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[])[0];
    const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as {
      seriesInstanceUid: string; modality: string; numberOfInstances: number; seriesDescription?: string;
    }[];
    const cts = series.filter((s) => s.modality === "CT");
    const ct = cts.find((s) => /LIVER/i.test(s.seriesDescription ?? "")) ?? cts.sort((a, b) => b.numberOfInstances - a.numberOfInstances)[0];
    check(!!ct, "実物の CT が取り込まれている（操作が効いている前提）", series);

    // 前提: 「この PC」の Python が、固定した（何も入っていない）venv で、使えない（Jupyter が無い）と検出される
    const det = await page.evaluate(() => (window as unknown as { graphyDesktop: { computeLocalDetect: (o: unknown) => Promise<{ selected?: { path: string } | null; usable: boolean; python?: unknown; reasons?: string[] }> } }).graphyDesktop.computeLocalDetect({ force: true }));
    console.log(`    検出: ${JSON.stringify({ python: det.python, selected: det.selected?.path, usable: det.usable, reasons: det.reasons })}`);
    check(det.usable === false && String(det.selected?.path ?? "").startsWith(bare.replace(/\/bin$/, "")), "前提: 固定した venv が選ばれ、使えない（Jupyter が無い）", det);

    await dismissStartupDialogs(page);
    const viewer = await openViewer(driver, page, study.studyInstanceUid, ct.seriesInstanceUid);
    await viewer.getByTestId("monai-bundle").selectOption("spleen_ct_segmentation");

    console.log("\n[1] Jupyter が無い状態で「実行」→ local-unavailable（失敗側）");
    await viewer.getByTestId("monai-run").click();
    await viewer.waitForFunction(() => /local-unavailable/.test(JSON.stringify((window as unknown as { __monaiState?: unknown }).__monaiState ?? {})), null, { timeout: 120_000 })
      .catch(() => undefined);
    const s1 = await state(viewer);
    const failed1 = /local-unavailable/.test(JSON.stringify(s1 ?? {}));
    check(failed1, "Jupyter が無い状態では local-unavailable になる（失敗側が確かに失敗している）", { phase: s1?.phase, error: s1?.error });
    const windowsBefore = driver.app.windows().filter((w) => w.url().endsWith("computeConsent.html")).length;
    check(windowsBefore === 0, "このとき同意画面は開かない");
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-unavailable.png") });

    console.log("\n[2] 本体は再起動せず、Jupyter 等を「入れた」（.pth）");
    fs.writeFileSync(pth, `${sites.join("\n")}\n`);
    await new Promise((r) => setTimeout(r, 2500)); // 検出し直してよくなるまで（覚えて 2 秒以内は検出し直さない）

    console.log("\n[3] もう一度「実行」→ 事前チェックの同意画面まで進む");
    await viewer.getByTestId("monai-run").click();
    let reached = false;
    let code = "";
    try {
      const pw = await consentWindow(driver, 120_000);
      code = (await pw.locator("#code").textContent()) ?? "";
      reached = true;
      await pw.screenshot({ path: path.join(OUT_DIR, "2-consent.png") });
      await pw.getByTestId("consent-cancel").click();
    } catch {
      /* 同意画面が開かなかった */
    }
    check(reached, "再起動なしで、同意画面（事前チェック）まで進む", await state(viewer).then((s) => ({ phase: s?.phase, error: s?.error })));
    check(code.includes("outputs/env.json") && !code.includes("monai.bundle"), "同意画面は事前チェックのコード（環境の確認だけ）", code.slice(0, 80));
  } finally {
    await driver.stop();
    fs.rmSync(pth, { force: true });
    if (backup !== null) fs.writeFileSync(ENDPOINTS, backup);
    else fs.rmSync(ENDPOINTS, { force: true });
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

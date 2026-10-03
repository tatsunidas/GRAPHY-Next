/*
 * Google Colab（段 9）の実機検証。設計: fw/remote-compute-design.md §15。
 *
 * 実行:  cd automator && npx tsx src/spike/computeColabCheck.ts
 *
 * 🔴 **人の操作が要る**: ログインしていなければ途中でブラウザが開くので、テストユーザーの Google アカウントで
 *    ログインして許可する（5 分待つ）。ログインは残す（refresh token は desktop/secrets.enc.json・OS で暗号化）。
 * 🔴 **利用者の Colab の利用枠を数分使う**（GPU T4。プランで使えなければ CPU）。最後に必ず解放する。
 *
 * 確かめること（本物の Electron ＋ backend ＋ Google Colab）:
 *   1. 設定画面から Google でログインできる・プランが出る
 *   2. Colab の計算機を足すと main の確認ダイアログに「Google Colab」と出る
 *   3. ランタイムを確保できる・接続テストで GPU の名前が出る
 *   4. プラグインの runJob が Colab で走る（同意画面の送り先は *.prod.colab.dev・届いたバイト列の SHA-256 が一致・
 *      届いた npz に患者 ID・元の UID が無い）
 *   5. 解放できる・監査ログに送信と終了が残る
 *
 * 前提: backend jar・fixture ct-basic・desktop/colab-oauth-client.json。
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import {
  RUNJOB_PLUGIN_ID,
  approvedSha,
  consentWindow,
  createChecker,
  launchRunJobPlugin,
  runJobOutcome,
} from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-colab-check");
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");
const { check, summary } = createChecker();

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", RUNJOB_PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(AUTOMATOR_ROOT, "plugins", RUNJOB_PLUGIN_ID, n), path.join(dst, n));
  fs.rmSync(AUDIT, { force: true });

  const driver = new DesktopDriver();
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  let endpointId: string | null = null;
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });

    const cwd = await driver.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg: unknown[] };
      g.__dlg = [];
      dialog.showMessageBoxSync = ((...args: unknown[]) => (g.__dlg.push(args[args.length - 1]), 0)) as typeof dialog.showMessageBoxSync;
      return process.cwd();
    });
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    if (endpointsBackup !== null) fs.rmSync(endpointsFile);

    // --- 1. ログイン ---
    console.log("\n[1] Google でログイン");
    await page.getByTestId("mainscreen-menu-system").click();
    await page.getByTestId("menu-item-settings").click();
    await page.getByTestId("settings-cat-compute").click();
    await page.getByTestId("compute-colab").waitFor({ state: "visible", timeout: 10_000 });
    if ((await page.getByTestId("compute-colab-account").count()) === 0) {
      console.log("    → ブラウザが開きます。テストユーザーの Google アカウントでログインして許可してください（5 分待ちます）");
      await page.getByTestId("compute-colab-signin").click();
      await page.getByTestId("compute-colab-account").waitFor({ state: "visible", timeout: 300_000 });
    }
    await page.waitForFunction(() => !(document.querySelector('[data-testid="compute-colab-account"]')?.textContent ?? "").includes("…"), null, { timeout: 30_000 });
    const account = (await page.getByTestId("compute-colab-account").textContent()) ?? "";
    check(/@/.test(account), "ログインしたアカウントとプランが出る", account);

    // --- 2. Colab の計算機を足す ---
    console.log("\n[2] Colab の計算機を足す");
    const options = await page.getByTestId("compute-colab-spec").locator("option:not([disabled])").evaluateAll((os) =>
      os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    const pick = options.find((v) => v === "VARIANT_GPU/T4/SHAPE_STANDARD") ?? options.find((v) => v.startsWith("VARIANT_CPU/"))!;
    console.log(`    使う種類: ${pick}`);
    await page.getByTestId("compute-colab-spec").selectOption(pick);
    await page.getByTestId("compute-colab-add").click();
    endpointId = `colab-${pick.split("/")[1].toLowerCase()}`;
    await page.getByTestId(`compute-endpoint-${endpointId}`).waitFor({ state: "visible", timeout: 10_000 });
    const dlg = await driver.app.evaluate(() => (globalThis as unknown as { __dlg: { detail?: string }[] }).__dlg);
    check(dlg.some((d) => String(d.detail).includes("Google Colab")), "🔴 main の確認ダイアログに「Google Colab」と出る", dlg);

    // --- 3. 確保と接続テスト ---
    console.log("\n[3] ランタイムの確保と接続テスト");
    const t0 = Date.now();
    await page.getByTestId(`compute-colab-ensure-${endpointId}`).click();
    await page.getByTestId(`compute-colab-release-${endpointId}`).waitFor({ state: "visible", timeout: 300_000 });
    check(true, `ランタイムを確保できる（${Math.round((Date.now() - t0) / 1000)} 秒）`);
    await page.getByTestId(`compute-test-${endpointId}`).click();
    const ok = page.getByTestId("compute-test-ok");
    const failed = page.getByTestId("compute-test-failed");
    await Promise.race([ok.waitFor({ timeout: 180_000 }), failed.waitFor({ timeout: 180_000 })]);
    const okText = (await ok.count()) > 0 ? ((await ok.textContent()) ?? "") : "";
    check(okText.includes("Python"), "接続テストが通る", (await failed.count()) > 0 ? await failed.textContent() : okText);
    if (pick.includes("GPU")) check(/GPU: .*T4/.test(okText), "GPU の名前（T4）が出る", okText);
    console.log(`    → ${okText}`);
    await page.screenshot({ path: path.join(OUT_DIR, "1-colab-settings.png") });
    await page.getByTestId("dialog-close-button").click();

    // --- 4. runJob ---
    console.log("\n[4] プラグインの runJob を Colab で");
    const base = `http://localhost:${driver.ports.http}`;
    const study = ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId: string }[])[0];
    const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as {
      seriesInstanceUid: string; modality: string; numberOfInstances: number;
    }[];
    const ct = series.find((s) => s.modality === "CT") ?? series[0];
    await launchRunJobPlugin(page, { studyUid: study.studyInstanceUid, seriesUid: ct.seriesInstanceUid, endpointId });
    const win = await consentWindow(driver, 120_000);
    const url = (await win.getByTestId("consent-url").textContent()) ?? "";
    check(/\.prod\.colab\.dev\/?$/.test(url), "同意画面の送り先が Colab のランタイム", url);
    const sha = await approvedSha(win);
    await win.screenshot({ path: path.join(OUT_DIR, "2-consent.png") });
    await win.getByTestId("consent-ack").check();
    await win.getByTestId("consent-send").click();
    const run = await runJobOutcome(page, 300_000);
    const o = run.outcome;
    fs.writeFileSync(path.join(OUT_DIR, "outcome.json"), JSON.stringify(run, null, 2));
    check(o.ok === true && o.status === "ok", "Colab で最後まで走る", { error: o.error, stderr: o.stderr, ev: o.errorValue });
    check(o.summary?.sha256 === sha && sha.length === 64, "🔴 Colab に届いたバイト列の SHA-256 が同意画面の値と一致する", { received: o.summary?.sha256, approved: sha });
    check(o.summary?.shape?.[0] === ct.numberOfInstances, "volume の枚数", o.summary?.shape);
    const meta = JSON.stringify(o.summary?.meta ?? {});
    check(!meta.includes(study.patientId) && !meta.includes(ct.seriesInstanceUid), "🔴 届いたデータに患者 ID・元の UID が無い");
    check(o.maskBytes > 128, "結果（mask.npy）を取り出せる", o.maskBytes);

    // --- 5. 解放と監査 ---
    console.log("\n[5] 解放と監査");
    const released = await page.evaluate((id) => (window as unknown as { graphyDesktop: any }).graphyDesktop.computeColabRelease(id), endpointId);
    check(released.ok === true && released.released === true, "ランタイムを解放できる", released);
    const st = await page.evaluate(async (id) => {
      const c = await (window as unknown as { graphyDesktop: any }).graphyDesktop.computeEndpointsGet();
      return c.endpoints.find((e: { id: string }) => e.id === id)?.runtime;
    }, endpointId);
    check(st?.allocated === false, "解放後は未確保", st);
    const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const fin = events.find((e: { event: string }) => e.event === "compute-finished");
    check(fin?.outcome === "ok", "監査: Colab での実行が ok で残る", fin);
    check(events.some((e: { event: string; host?: string }) => e.event === "egress-approved" && /prod\.colab\.dev$/.test(e.host ?? "")), "監査: 送り先の host が Colab");
  } finally {
    // 確保したまま終わらない（失敗しても解放する）
    if (endpointId) {
      await driver.page.evaluate((id) => (window as unknown as { graphyDesktop: any }).graphyDesktop.computeColabRelease(id), endpointId).catch(() => undefined);
    }
    await driver.stop();
    if (endpointsFile) {
      if (endpointsBackup !== null) fs.writeFileSync(endpointsFile, endpointsBackup);
      else fs.rmSync(endpointsFile, { force: true });
    }
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

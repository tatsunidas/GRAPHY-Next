/*
 * URL を指定した取り込み（fw/dicom-data-layer.md §4.4）を実アプリで確かめる。
 *
 * 実行:  cd automator && npx tsx src/spike/urlImportCheck.ts
 *
 * 1. ファイル > URL から取り込む… で、手元の HTTP サーバーの DICOM を取り込むと一覧に検査が出る
 * 2. DICOM でないファイル（Raw）を指定すると、非DICOM取込の画面がそのファイルで開き、閉じると一時ファイルが消える
 * 3. ftp:// は理由つきで断られる
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "url-import-check");
const PATIENT_ID = "RAW-URL";
const { check, summary } = createChecker();

function findFiles(dir: string, re: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findFiles(p, re));
    else if (re.test(e.name)) out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Raw（8×6×2・uint8）。取り込み元の DICOM を作るのにも、非 DICOM の確認にも使う
  const raw = path.join(OUT_DIR, "phantom.raw");
  fs.writeFileSync(raw, Buffer.from(Array.from({ length: 8 * 6 * 2 }, (_, i) => i)));

  const driver = new DesktopDriver();
  const served = path.join(OUT_DIR, "served.dcm");
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.url?.startsWith("/scan.dcm")) {
      res.writeHead(200, { "Content-Type": "application/dicom" });
      res.end(fs.readFileSync(served));
    } else if (req.url === "/phantom.raw") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(fs.readFileSync(raw));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const httpBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    const base = `http://localhost:${driver.ports.http}`;
    // 取り込み元の DICOM を本体に作らせ、保管された 1 枚を配信用に写してから DB を空にする
    const made = await fetch(`${base}/api/raw/import`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: raw, spec: { width: 8, height: 6, slices: 2, phases: 1, type: "uint8", byteOrder: "little", offset: 0, spacing: [1, 1, 1], orientation: "axial" }, modality: "MR", patientId: PATIENT_ID }),
    });
    check(made.ok, "取り込み元の DICOM を作れる", made.status);
    const dcm = findFiles(path.join(DESKTOP_RUN_DATA_DIR, "data", "dicom"), /\.dcm$/)[0];
    fs.copyFileSync(dcm, served);
    await resetDb(driver.ports.http);
    const before = (await (await fetch(`${base}/api/studies`)).json()) as unknown[];
    check(before.length === 0, `DB を空にした（${before.length} 件）`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    const openUrlDialog = async () => {
      await page.getByText(/^(ファイル|File)$/).first().click();
      await page.getByTestId("menu-item-url-import").click();
      await page.getByTestId("url-import-input").waitFor({ state: "visible", timeout: 10_000 });
    };

    // ── 1. DICOM ──
    await openUrlDialog();
    await page.getByTestId("url-import-input").fill(`${httpBase}/scan.dcm?token=secret`);
    await page.getByTestId("url-import-start").click();
    await page.getByTestId("url-import-done").waitFor({ state: "visible", timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT_DIR, "dicom-done.png") });
    const after = (await (await fetch(`${base}/api/studies`)).json()) as { patientId: string }[];
    check(after.length === 1 && after[0].patientId === PATIENT_ID, `URL の DICOM が取り込まれ一覧に出る（${after.length} 件）`, after);
    check(requests.some((u) => u.startsWith("/scan.dcm")), "HTTP サーバーに取得が届いた", requests);
    const logText = fs.readdirSync(DESKTOP_RUN_DATA_DIR).includes("logs") ? findFiles(path.join(DESKTOP_RUN_DATA_DIR, "logs"), /\.log$/).map((f) => fs.readFileSync(f, "utf8")).join("\n") : "";
    if (logText) check(!logText.includes("token=secret"), "ログに URL のクエリ（秘密）が出ない");
    await page.getByLabel(/^(閉じる|Close)$/).first().click();

    // ── 2. 非 DICOM（Raw）→ 非DICOM取込の画面で続ける ──
    await openUrlDialog();
    await page.getByTestId("url-import-input").fill(`${httpBase}/phantom.raw`);
    await page.getByTestId("url-import-start").click();
    await page.getByTestId("raw-size-status").waitFor({ state: "visible", timeout: 30_000 });
    const dialogText = await page.locator("body").innerText();
    check(/phantom\.raw/.test(dialogText), "非DICOM取込の画面が、落としたファイルを選んだ状態で開く");
    await page.screenshot({ path: path.join(OUT_DIR, "nondicom-opened.png") });
    const tmpDir = path.join(DESKTOP_RUN_DATA_DIR, "data", "dicom", ".import");
    check(findFiles(tmpDir, /^url-/).length === 1, "落とした一時ファイルが作業フォルダにある", findFiles(tmpDir, /^url-/));
    await page.getByLabel(/^(閉じる|Close)$/).first().click();
    await page.waitForTimeout(1000);
    check(findFiles(tmpDir, /^url-/).length === 0, "非DICOM取込の画面を閉じると一時ファイルが消える", findFiles(tmpDir, /^url-/));

    // ── 3. 断る ──
    await openUrlDialog();
    await page.getByTestId("url-import-input").fill("ftp://example.com/a.dcm");
    await page.getByTestId("url-import-start").click();
    await page.getByTestId("url-import-error").waitFor({ state: "visible", timeout: 10_000 });
    const err = await page.getByTestId("url-import-error").innerText();
    check(/http/.test(err), `ftp:// は理由つきで断られる（${err}）`);
    await page.screenshot({ path: path.join(OUT_DIR, "refused.png") });
  } finally {
    await driver.stop();
    server.close();
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/*
 * Anonymizer の **ZIP 出力ボタン**だけを実機（Electron）で通し、
 * 「ブラウザ側が実際にディスクへ落とした ZIP」をバイト単位で確かめるスパイク。
 *
 * checklist の `07-anonymizer.item-04` は「完了メッセージが出たか」しか見ていない
 * （`page.waitForEvent("download")` が Electron で発火しないため、そう書かれている）。
 * つまり **中身が空でも PASS になる**。ユーザー報告「ZIP で出力したが空だった」を
 * 切り分けるために、ここでは次を分けて測る:
 *
 *   A. backend が HTTP で返す ZIP（REST を直叩き）      … サーバ側が正しいか
 *   B. レンダラが blob から保存した ZIP（実機のボタン）  … クライアント側が正しいか
 *
 * A が正常で B が空なら、原因は `AnonymizerDialog.runZip()` の blob → <a download> 経路。
 *
 * 実行:
 *   cd automator && npx tsx src/spike/anonZipCheck.ts [--patient=<PatientID>]
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）。
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "anon-zip-check");

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

/** ZIP の中央ディレクトリを数えて「何エントリ入っているか」を返す（外部依存なしで済ませる）。 */
function zipEntryCount(file: string): { bytes: number; entries: number; looksLikeZip: boolean } {
  const buf = fs.readFileSync(file);
  let entries = 0;
  // central directory file header signature = 0x02014b50
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50) entries++;
  }
  return { bytes: buf.length, entries, looksLikeZip: buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50 };
}

async function main(): Promise<void> {
  const patientId = arg("patient") ?? "";
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const driver = new DesktopDriver();
  await driver.start();
  const page = driver.page;
  const recorder = createStepRecorder();

  try {
    await waitForMainScreenReady(page);

    // ── ダウンロードを既知のパスへ落とす（Electron は既定でダイアログを出すか
    //    既定フォルダへ落とすので、そのままでは検証にならない）。
    const savePath = path.join(OUT_DIR, "downloaded.zip");
    // main プロセス側には `require` が無い（ESM）ので、状態はグローバルに置いて後で読み出す。
    await driver.app.evaluate(({ session }, sp) => {
      session.defaultSession.removeAllListeners("will-download");
      (globalThis as any).__zipDownload = null;
      session.defaultSession.on("will-download", (_e: unknown, item: any) => {
        item.setSavePath(sp);
        (globalThis as any).__zipDownload = { state: "started", filename: item.getFilename() };
        item.once("done", (_ev: unknown, state: string) => {
          (globalThis as any).__zipDownload = {
            state,
            filename: item.getFilename(),
            receivedBytes: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes(),
            mimeType: item.getMimeType(),
          };
        });
      });
    }, savePath);
    recorder.step("will-download を横取りして保存先を固定", { savePath });

    // ── 検索（PatientID で絞ると ZIP の対象が決定的になる。Anonymizer は
    //    「選択したスタディ」ではなく「検索結果全体」を対象にするため）。
    const dateInputs = page.locator('input[type="date"]');
    await dateInputs.nth(0).fill("");
    await dateInputs.nth(1).fill("");
    await page.getByTestId("search-patientid-input").fill(patientId);
    await page.getByTestId("search-submit-button").click();
    await page.locator('[data-testid^="study-row-"]').first().waitFor({ state: "visible", timeout: 15_000 });
    const rowCount = await page.locator('[data-testid^="study-row-"]').count();
    recorder.step("検索", { patientId: patientId || "(無条件)", studyRows: rowCount });

    // ── A: backend が返す ZIP を REST で直に取る（同じ studyUids で）。
    //     ⚠ renderer から相対 `/api/...` を叩いてはいけない。automator が起動する Vite は
    //     `VITE_BACKEND_URL` 未設定＝既定 `http://localhost:8080` へプロキシするため、
    //     その口は backend ではなく**別のもの（ローカルの dcm4chee 等）**に繋がりうる。
    //     アプリ本体は preload 由来のポートで絶対 URL を組むので影響を受けない。
    const api = `http://127.0.0.1:${driver.ports.http}`;
    const studyUids: string[] = await fetch(
      `${api}/api/studies${patientId ? `?patientId=${encodeURIComponent(patientId)}` : ""}`,
    )
      .then((r) => r.json())
      .then((arr: { studyInstanceUid: string }[]) => arr.map((x) => x.studyInstanceUid));
    const restZip = path.join(OUT_DIR, "rest.zip");
    const restRes = await fetch(`${api}/api/anonymizer/zip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        studyUids,
        options: [], replacePatientName: "ANON", replacePatientId: "ANON",
        randomSeed: null, manualRetainTags: [], customReplacements: {}, burnIn: false,
      }),
    });
    fs.writeFileSync(restZip, Buffer.from(await restRes.arrayBuffer()));
    const a = zipEntryCount(restZip);
    recorder.step("A: REST 直叩きの ZIP", { http: restRes.status, studyUids: studyUids.length, ...a });

    // ── B: 実機のボタンで落とす。
    await page.getByTestId("toolbar-anonymizer-btn").click();
    await page.getByTestId("anonymizer-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("anon-new-id-input").fill("ANON_ZIPCHK");
    await page.getByTestId("anon-zip-btn").click();
    await page.getByTestId("anon-info-message").waitFor({ state: "visible", timeout: 60_000 });
    const infoText = await page.getByTestId("anon-info-message").textContent();
    recorder.step("B: ZIP ボタンの完了メッセージ", { infoText });

    // ダウンロード完了を待つ（main プロセス側のグローバルを読みに行く）。
    const deadline = Date.now() + 60_000;
    let downloadState: any = null;
    while (Date.now() < deadline) {
      downloadState = await driver.app.evaluate(() => (globalThis as any).__zipDownload ?? null);
      if (downloadState && downloadState.state !== "started") break;
      await page.waitForTimeout(500);
    }
    if (!downloadState) downloadState = { state: "(will-download が一度も発火しなかった)" };
    const b = fs.existsSync(savePath)
      ? zipEntryCount(savePath)
      : { bytes: -1, entries: -1, looksLikeZip: false };
    recorder.step("B: 保存された ZIP", { downloadState, ...b });

    console.log("\n===== 結果 =====");
    for (const s of recorder.steps) {
      console.log(`- ${s.description}${s.detail ? ` ${JSON.stringify(s.detail)}` : ""}`);
    }
    console.log("\n判定:");
    console.log(`  A(backend が返す ZIP)      : ${a.bytes} bytes / ${a.entries} entries`);
    console.log(`  B(実機が保存した ZIP)      : ${b.bytes} bytes / ${b.entries} entries`);
    if (a.entries > 0 && b.entries <= 0) {
      console.log("  → backend は正常。**クライアント側（blob → <a download>）で中身が失われている**");
    } else if (a.entries <= 0) {
      console.log("  → backend が空の ZIP を返している（対象インスタンスが 0 件の可能性）");
    } else {
      console.log("  → A も B も中身あり（この条件では再現せず）");
    }
  } finally {
    await driver.stop();
  }
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

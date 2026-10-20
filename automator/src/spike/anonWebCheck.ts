/*
 * web モードの匿名化ダイアログ（ZIP ジョブ・PACS への保存）を実物の web + PACS で検証する。
 *
 * 実行（PACS には匿名化の元になるスタディが入っていること。既定は PatientName TEST^BURNED のもの）:
 *   java -jar backend/target/graphy-next-backend.jar --spring.profiles.active=web --server.port=8091 \
 *     --graphy.dicom.scp.port=11191 --graphy.dicom.dicomweb.base-url=<PACS の RS ベース> \
 *     --graphy.web.import-enabled=true        # false の起動でも走らせ、EXPECT_IMPORT=0 を付ける
 *   cd automator && npx tsx src/spike/anonWebCheck.ts
 *
 * 環境変数: GRAPHY_WEB_URL（既定 http://localhost:8091）、GRAPHY_PACS_RS、EXPECT_IMPORT（1=許可あり / 0=なし。既定 1）。
 * PACS の実体は QIDO で直接見る（画面の表示だけで判定しない）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium, type Browser, type Page } from "@playwright/test";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const WEB_URL = process.env.GRAPHY_WEB_URL ?? "http://localhost:8091";
const PACS_RS = process.env.GRAPHY_PACS_RS ?? "http://localhost:18080/dcm4chee-arc/aets/DCM4CHEE/rs";
const EXPECT_IMPORT = (process.env.EXPECT_IMPORT ?? "1") === "1";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", `anon-web-${EXPECT_IMPORT ? "import-on" : "import-off"}`);

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

type Q = Record<string, { Value?: unknown[] }>;

async function qido(pathAndQuery: string): Promise<Q[]> {
  const res = await fetch(`${PACS_RS}${pathAndQuery}`);
  if (res.status === 204) return [];
  if (!res.ok) throw new Error(`QIDO ${pathAndQuery} → ${res.status}`);
  return (await res.json()) as Q[];
}

const studyUids = async (): Promise<string[]> =>
  (await qido("/studies?limit=500")).map((r) => String(r["0020000D"]?.Value?.[0] ?? ""));

async function instanceCount(studyUid: string): Promise<number> {
  return (await qido(`/studies/${encodeURIComponent(studyUid)}/instances?limit=500`)).length;
}

/** 元にするスタディ: TEST^BURNED で 3 枚のもの。 */
async function pickSource(): Promise<string> {
  for (const r of await qido("/studies?limit=500")) {
    const name = (r["00100010"]?.Value?.[0] as { Alphabetic?: string } | undefined)?.Alphabetic;
    const uid = String(r["0020000D"]?.Value?.[0] ?? "");
    if (name === "TEST^BURNED" && (await instanceCount(uid)) === 3) return uid;
  }
  throw new Error("元にする TEST^BURNED（3 枚）のスタディが PACS にありません");
}

async function openDialog(page: Page, sourceUid: string): Promise<void> {
  page.once("dialog", (d) => void d.accept());
  // 初回の利用条件の確認（同意するまで画面を覆う）。
  const agree = page.getByRole("button", { name: "同意して使う" });
  if (await agree.isVisible({ timeout: 3000 }).catch(() => false)) await agree.click();
  const dates = page.locator('input[type="date"]');
  await dates.nth(0).fill("");
  await dates.nth(1).fill("");
  await page.getByTestId("search-submit-button").click();
  await page.getByTestId(`study-row-${sourceUid}`).click();
  await page.getByRole("button", { name: "匿名化", exact: true }).click();
  await page.getByTestId("anonymizer-dialog").waitFor({ state: "visible", timeout: 15_000 });
}

async function waitMessage(page: Page, testId: string, timeoutMs = 60_000): Promise<string> {
  await page.getByTestId(testId).waitFor({ state: "visible", timeout: timeoutMs });
  return (await page.getByTestId(testId).textContent()) ?? "";
}


const PY = "C:/Users/t_kob/anaconda3/python.exe";

/** ZIP 内の複数フレームの画像について、矩形（2..10）の内側と、遠い隅（14..15。塗りは外へ 2 画素広げる既定のため近傍は避ける）の画素値の集合を返す。 */
function burnStats(zipPath: string): { inside: number[]; outside: number[] } {
  const code = [
    "import sys,zipfile,io,json,pydicom",
    "z=zipfile.ZipFile(sys.argv[1]);out=None",
    "for n in z.namelist():",
    "  ds=pydicom.dcmread(io.BytesIO(z.read(n)))",
    "  if int(getattr(ds,'NumberOfFrames',1))>1:",
    "    a=ds.pixel_array",
    "    out={'inside':sorted(set(int(v) for v in a[:,2:10,2:10].ravel())),'outside':sorted(set(int(v) for v in a[:,14:,14:].ravel()))}",
    "print(json.dumps(out))",
  ].join("\n");
  const r = spawnSync(PY, ["-c", code, zipPath], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pydicom 解析に失敗: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

async function zipOnce(page: Page): Promise<string> {
  const dl = page.waitForEvent("download", { timeout: 90_000 });
  await page.getByTestId("anon-zip-btn").click();
  const file = path.join(os.tmpdir(), `anon-web-burn-${Date.now()}.zip`);
  await (await dl).saveAs(file);
  return file;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const status = await fetch(`${WEB_URL}/api/status`).then((r) => r.json()).catch(() => null);
  if (!status || status.mode !== "web") {
    console.log(`web モードの backend が ${WEB_URL} にありません（${JSON.stringify(status)}）。ファイル冒頭を参照。`);
    process.exitCode = 1;
    return;
  }
  const cfg = await fetch(`${WEB_URL}/api/anonymizer/jobs/config`).then((r) => r.json());
  check(cfg.importEnabled === EXPECT_IMPORT, `サーバー設定 importEnabled=${EXPECT_IMPORT}`, cfg);

  const source = await pickSource();
  const sourceCount = await instanceCount(source);
  const studiesBefore = await studyUids();
  console.log(`source=${source} (${sourceCount} 枚) / PACS のスタディ ${studiesBefore.length} 件`);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: "ja-JP", acceptDownloads: true });
    const page = await ctx.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.goto(`${WEB_URL}/`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await openDialog(page, source);
    await page.screenshot({ path: path.join(OUT_DIR, "1-dialog.png") });

    const stowBtn = page.getByTestId("anon-stow-btn");
    check((await stowBtn.count()) === (EXPECT_IMPORT ? 1 : 0), `「PACS に保存」ボタンは許可${EXPECT_IMPORT ? "あり" : "なし"}で${EXPECT_IMPORT ? "出る" : "出ない"}`);
    check(!(await page.getByText("匿名化は standalone 専用です").count()), "standalone 専用の注記が出ない");

    // 既定は「UID を保持」が ON。ON のままだと保存は無効になる（その確認は最後）。匿名化の本来の形で試す。
    await page.getByTestId("anon-opt-RetainUIDs").uncheck();

    // ── ZIP ジョブ
    const dl = page.waitForEvent("download", { timeout: 90_000 });
    await page.getByTestId("anon-zip-btn").click();
    const download = await dl;
    const zipPath = path.join(os.tmpdir(), `anon-web-${Date.now()}.zip`);
    await download.saveAs(zipPath);
    const listing = spawnSync("python", ["-c", "import sys,zipfile;print(chr(10).join(zipfile.ZipFile(sys.argv[1]).namelist()))", zipPath], { encoding: "utf8" }).stdout.split(/\r?\n/).filter((l) => l.endsWith(".dcm"));
    check(listing.length === sourceCount, "ZIP ジョブで匿名化した画像が元と同じ枚数入っている", { zip: listing.length, source: sourceCount });
    check(!listing.some((l) => l.includes(source)), "ZIP 内のスタディ UID が元と違う", listing[0]);
    const info = await waitMessage(page, "anon-info-message");
    check(/ZIP を出力しました/.test(info), "完了メッセージが出る", info);
    await page.screenshot({ path: path.join(OUT_DIR, "2-zip-done.png") });
    fs.rmSync(zipPath, { force: true });

    check((await instanceCount(source)) === sourceCount, "ZIP 出力では PACS の元スタディが変わらない");

    if (EXPECT_IMPORT) {
      // ── PACS に保存: 確認で「やめる」→ 何も送られない
      await stowBtn.click();
      check(await page.getByTestId("anon-stow-confirm").isVisible(), "保存ボタンで確認が出る（取り消せないことの案内）");
      const confirmText = (await page.getByTestId("anon-stow-confirm").textContent()) ?? "";
      check(/取り消せません/.test(confirmText), "確認文に「取り消せない」が入っている", confirmText);
      await page.screenshot({ path: path.join(OUT_DIR, "3-stow-confirm.png") });
      await page.getByTestId("anon-stow-confirm-cancel").click();
      await page.waitForTimeout(1500);
      check((await studyUids()).length === studiesBefore.length, "確認で「やめる」と PACS に何も増えない（負例）");

      // ── 保存する → 新スタディが PACS に入る
      await stowBtn.click();
      await page.getByTestId("anon-stow-confirm-ok").click();
      const done = await waitMessage(page, "anon-info-message");
      check(/PACS に新しいスタディとして/.test(done), "保存完了のメッセージ", done);
      await page.screenshot({ path: path.join(OUT_DIR, "4-stow-done.png") });
      let added: string[] = [];
      for (let i = 0; i < 20 && added.length === 0; i++) {
        added = (await studyUids()).filter((u) => !studiesBefore.includes(u));
        if (!added.length) await page.waitForTimeout(500);
      }
      check(added.length === 1, "PACS に新しいスタディが 1 件増えた", added);
      if (added.length === 1) {
        check(added[0] !== source, "新スタディの UID は元と違う");
        check((await instanceCount(added[0])) === sourceCount, "新スタディの枚数が元と同じ", await instanceCount(added[0]));
      }
      check((await instanceCount(source)) === sourceCount, "元のスタディは変わらない");

      // ── UID 保持 ON のとき保存は押せない（backend も 400）
      await page.getByTestId("anon-opt-RetainUIDs").check();
      check(await page.getByText("「UID を保持」が ON のときは PACS に保存できません").isVisible(), "無効の理由が画面に出る");
      check(await stowBtn.isDisabled(), "「UID を保持」が ON なら保存ボタンが無効");
      await page.screenshot({ path: path.join(OUT_DIR, "5-retain-uids.png") });
      await page.getByTestId("anon-opt-RetainUIDs").uncheck();
    } else {
      // 許可なしのサーバーに直接投げても 403
      const r = await fetch(`${WEB_URL}/api/anonymizer/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Graphy-Request": "1" },
        body: JSON.stringify({ studyUids: [source], options: [], replacePatientName: "a", replacePatientId: "b", output: "stow", burnIn: false }),
      });
      check(r.status === 403, "許可なしのサーバーは stow を 403 で拒否", r.status);
      check((await studyUids()).length === studiesBefore.length, "拒否後も PACS に何も増えない");
    }

    // ── 焼き込み（web: チェックした ROI をジョブ要求に載せる）。16×16・3 フレームの一様な画像に、
    //    矩形 ROI（画素 2..10）を保存しておき、塗られた場所を画素で確かめる。
    const runSeries = (await (await fetch(`${WEB_URL}/api/studies/${source}/series`)).json() as { seriesInstanceUid: string }[])
      .find((x) => x.seriesInstanceUid.endsWith(".3"))!.seriesInstanceUid;
    const layout = await (await fetch(`${WEB_URL}/api/studies/${source}/series/${runSeries}/layout`)).json();
    const sop = layout.cells[0].sopInstanceUid as string;
    const roiJson = JSON.stringify({
      schema: 1,
      rois: [{
        roiUid: "roi-burn-1", tool: "RectangleROI", sopInstanceUid: sop, seriesUid: runSeries, frame: 0,
        points: [[2, 2, 0], [10, 2, 0], [10, 10, 0], [2, 10, 0]], isOpenContour: false, label: "burnrect",
      }],
    });
    const put = await fetch(`${WEB_URL}/api/rois?patientKey=P1`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ json: roiJson, roiCount: 1, version: null }),
    });
    check(put.ok, "検証用の ROI を保存できた", put.status);
    await page.getByRole("checkbox", { name: /ピクセル焼き込み除去/ }).check();
    await page.getByRole("checkbox", { name: /ピクセル焼き込みを実行/ }).check();
    await page.getByTestId("anon-mask-roi-row").first().waitFor({ state: "visible", timeout: 15_000 });
    check((await page.getByTestId("anon-mask-roi-row").count()) === 1, "web でも面 ROI の候補が出る");
    check(await page.getByTestId("anon-mask-apply").count() === 0, "web には「登録」ボタンが無い（ジョブに載せる）");
    await page.screenshot({ path: path.join(OUT_DIR, "6-roi-list.png") });

    // 負例: チェックなし → 塗られず、警告が出る
    const zipA = await zipOnce(page);
    const noRoi = burnStats(zipA);
    const errA = await waitMessage(page, "anon-error-message");
    check(noRoi.inside.length === 1 && noRoi.outside.length === 1 && noRoi.inside[0] === noRoi.outside[0], "ROI を選ばないと画素は塗られない（一様のまま）", noRoi);
    check(/焼き込みしていません/.test(errA), "塗れなかった旨の警告が出る", errA);
    fs.rmSync(zipA, { force: true });

    // 正例: チェックあり → 矩形の内側だけが別の値になる
    await page.getByTestId("anon-mask-roi-row").first().locator("input").check();
    const zipB = await zipOnce(page);
    const withRoi = burnStats(zipB);
    check(withRoi.inside.length === 1 && withRoi.inside[0] !== noRoi.inside[0], "チェックした ROI の内側が塗られる", { withRoi, noRoi });
    check(withRoi.outside.length === 1 && withRoi.outside[0] === noRoi.outside[0], "ROI の外側は変わらない", { withRoi, noRoi });
    await page.screenshot({ path: path.join(OUT_DIR, "7-burned.png") });
    fs.rmSync(zipB, { force: true });
    await fetch(`${WEB_URL}/api/rois?patientKey=P1`, { method: "DELETE" });

    check(consoleErrors.length === 0, "ページエラーが出ていない", consoleErrors.slice(0, 2));
  } finally {
    await browser?.close().catch(() => {});
  }

  console.log("\n=== 結果 ===");
  if (failures.length === 0) {
    console.log(`${passed} 項目すべて OK。スクリーンショット: ${OUT_DIR}`);
  } else {
    console.log(`FAIL ${failures.length} 件:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();

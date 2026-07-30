/*
 * H4b（プラグインの派生シリーズ保存）を **web モード**で検証する。
 * `deploy/dcm4chee/VERIFY-web.md` §③-2 の自動化版。
 *
 * 実行:
 *   # 1) dcm4chee を起動（docker）
 *   #    sudo docker compose -f deploy/dcm4chee/docker-compose.yml up -d
 *   # 2) 画像を投入
 *   #    ~/dcm4che-5.34.2/bin/storescu -c DCM4CHEE@localhost:11112 automator/fixtures/ct-basic
 *   # 3) UI 同梱 jar を web プロファイルで起動（プラグインは手置き＝web は導入 UI が 403）
 *   #    java -jar backend/target/graphy-next-backend.jar --spring.profiles.active=web \
 *   #      --server.port=8090 \
 *   #      --graphy.dicom.dicomweb.base-url=http://localhost:8080/dcm4chee-arc/aets/DCM4CHEE/rs \
 *   #      --graphy.plugins.dir=<hostapi-save を置いたディレクトリ>
 *   cd automator && npx tsx src/spike/h4bWebStowCheck.ts
 *
 * 環境変数で差し替え可: GRAPHY_WEB_URL（既定 http://localhost:8090）、
 * GRAPHY_PACS_RS（既定 http://localhost:8080/dcm4chee-arc/aets/DCM4CHEE/rs）。
 *
 * standalone との違いを見るのが主眼:
 *   - 確認ダイアログの保存先が「接続中の PACS（STOW-RS で書き戻し）」になる
 *   - 保存が **STOW-RS で外部 PACS へ書き戻る**（＝QIDO で実在が確認できる）
 *   - 拒否したときは PACS にシリーズが増えない
 *   - 出所（[Plugin] 接頭辞 / ImageType / DerivationDescription / PixelPaddingValue）が残る
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const WEB_URL = process.env.GRAPHY_WEB_URL ?? "http://localhost:8090";
const PACS_RS = process.env.GRAPHY_PACS_RS ?? "http://localhost:8080/dcm4chee-arc/aets/DCM4CHEE/rs";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "h4b-web-stow");

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

interface QidoSeries {
  uid: string;
  description: string | null;
  instances: number | null;
}

/** dcm4chee に直接 QIDO を投げてシリーズ一覧を取る（UI 越しではなく PACS の実体を見る）。 */
async function pacsSeries(studyUid: string): Promise<QidoSeries[]> {
  const res = await fetch(`${PACS_RS}/studies/${encodeURIComponent(studyUid)}/series`);
  if (res.status === 204) return [];
  if (!res.ok) throw new Error(`QIDO series failed: ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, { Value?: unknown[] }>>;
  return rows.map((r) => ({
    uid: String(r["0020000E"]?.Value?.[0] ?? ""),
    description: (r["0008103E"]?.Value?.[0] as string) ?? null,
    // ⚠ QIDO の IS 型は **文字列**で返る（"1"）。number として比較すると必ず外れる。
    instances: r["00201209"]?.Value?.[0] === undefined ? null : Number(r["00201209"].Value[0]),
  }));
}

/** 生成インスタンスのメタデータ（WADO-RS /metadata）から属性を読む。 */
async function pacsInstanceMeta(studyUid: string, seriesUid: string): Promise<Record<string, unknown>> {
  const url = `${PACS_RS}/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}/metadata`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WADO metadata failed: ${res.status}`);
  const arr = (await res.json()) as Array<Record<string, { Value?: unknown[] }>>;
  const a = arr[0] ?? {};
  const val = (tag: string): unknown => a[tag]?.Value?.[0];
  return {
    imageType: (a["00080008"]?.Value ?? []).join("\\"),
    derivation: val("00082111"),
    rescaleSlope: val("00281053"),
    rescaleIntercept: val("00281052"),
    rescaleType: val("00281054"),
    pixelPadding: val("00280120"),
    modality: val("00080060"),
    hasContributingEquipment: Boolean(a["0018A001"]),
  };
}

/** プラグインを実行し、保存ダイアログが出るまで待つ。 */
async function launchSavePlugin(page: Page): Promise<void> {
  await page.getByTestId("viewer2d-menu-plugins").click();
  await page.getByTestId("plugin-item-hostapi-save").click();
  await page.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 30_000 });
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 前提の疎通確認（どちらか欠けていれば、何を起動すべきかを示して終わる）。
  const webOk = await fetch(`${WEB_URL}/api/status`)
    .then((r) => r.json())
    .catch(() => null);
  if (!webOk || webOk.mode !== "web") {
    console.log(`web モードの backend が ${WEB_URL} で見つかりません（status=${JSON.stringify(webOk)}）。`);
    console.log("ファイル冒頭の起動手順を参照してください。");
    process.exitCode = 1;
    return;
  }
  const studies = (await (await fetch(`${WEB_URL}/api/studies`)).json()) as Array<{ studyInstanceUid: string }>;
  if (studies.length === 0) {
    console.log("PACS にスタディがありません。storescu で投入してください。");
    process.exitCode = 1;
    return;
  }
  const studyUid = studies[0].studyInstanceUid;
  console.log(`web=${WEB_URL} / PACS=${PACS_RS}\nstudy=${studyUid}`);

  const before = await pacsSeries(studyUid);
  console.log(`PACS の既存シリーズ: ${before.length} 本`);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const consoleErrors: string[] = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.goto(`${WEB_URL}/`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    check(true, "web モードの UI が開く（UI 同梱 jar 配信）");

    // 無条件検索 → スタディ → シリーズ（web は QIDO/WADO 経由）。
    page.once("dialog", (d) => void d.accept());
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator('[data-testid^="study-row-"]').first().click();
    const seriesRow = page.locator('[data-testid^="series-row-"]').first();
    await seriesRow.waitFor({ state: "visible", timeout: 30_000 });
    await seriesRow.click();
    await page.getByTestId("viewer2d-canvas-host").first().waitFor({ state: "visible", timeout: 60_000 });
    check(true, "web で 2D 画像が表示される（BFF 経由の WADO-RS）");

    // 2D Viewer 画面へ（web は同一タブで #2dviewer に遷移する場合がある）。
    const viewerPage = await openViewer(page, WEB_URL);
    viewerPage.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    await viewerPage.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
    await viewerPage.waitForTimeout(2500);

    // ── 1. 保存先の表示が web 用になっているか（standalone との分岐の目視ポイント）
    await launchSavePlugin(viewerPage);
    const dialogText = (await viewerPage.getByTestId("plugin-save-confirm").textContent())?.replace(/\s+/g, " ") ?? "";
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "1-confirm-web.png") });
    check(
      /PACS/.test(dialogText),
      "確認ダイアログの保存先が「接続中の PACS（STOW-RS）」になっている",
      dialogText.slice(0, 200),
    );
    check(/Host API Save/.test(dialogText), "プラグイン名と版が出ている", dialogText.slice(0, 120));

    // ── 2. 拒否したら PACS に増えない
    await viewerPage.getByTestId("plugin-save-cancel").click();
    await viewerPage.waitForTimeout(1500);
    const afterCancel = await pacsSeries(studyUid);
    check(
      afterCancel.length === before.length,
      "拒否したとき PACS にシリーズが増えない",
      { before: before.length, after: afterCancel.length },
    );

    // ── 3. 承諾すると STOW-RS で書き戻る
    await launchSavePlugin(viewerPage);
    await viewerPage.getByTestId("plugin-save-confirm-button").click();
    // 保存完了は PACS 側の出現で判定する（UI の通知に依存しない）。
    let created: QidoSeries | undefined;
    for (let i = 0; i < 40; i++) {
      const now = await pacsSeries(studyUid);
      created = now.find((s) => !before.some((b) => b.uid === s.uid));
      if (created) break;
      await viewerPage.waitForTimeout(1000);
    }
    check(!!created, "承諾すると PACS に新シリーズが現れる（STOW-RS 書き戻し）", created);
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "2-after-save.png") });

    if (created) {
      check(
        (created.description ?? "").startsWith("[Plugin] "),
        "SeriesDescription に [Plugin] 接頭辞が付く",
        created.description,
      );
      check(created.instances === 1, "インスタンス数が 1", created.instances);

      // ── 4. 出所と Rescale が PACS 側の属性に残っているか
      const meta = await pacsInstanceMeta(studyUid, created.uid);
      console.log(`  生成インスタンスの属性: ${JSON.stringify(meta)}`);
      check(/DERIVED/.test(String(meta.imageType)), "ImageType が DERIVED", meta.imageType);
      check(!String(meta.imageType).includes("RESLICE"), "ImageType に RESLICE を付けない", meta.imageType);
      check(/hostapi-save/.test(String(meta.derivation)), "DerivationDescription にプラグイン id", meta.derivation);
      check(meta.hasContributingEquipment === true, "ContributingEquipmentSequence が書かれている");
      check(Number(meta.rescaleSlope) === 1 && Number(meta.rescaleIntercept) === 0, "整数マスクは Rescale 恒等", {
        slope: meta.rescaleSlope,
        intercept: meta.rescaleIntercept,
      });
      check(meta.rescaleType === "HU", "RescaleType にプラグインが申告した単位", meta.rescaleType);
      check(Number(meta.pixelPadding) === -1000, "背景が PixelPaddingValue として残る", meta.pixelPadding);
      check(meta.modality === "CT", "モダリティは元シリーズを維持", meta.modality);
    }

    // ── 5. 元シリーズは無変更（本数は +1 のみ）
    const finalSeries = await pacsSeries(studyUid);
    check(finalSeries.length === before.length + 1, "元シリーズは残り、新シリーズが 1 本増える", {
      before: before.length,
      after: finalSeries.length,
    });

    const pixelErrors = consoleErrors.filter((m) => /pixel data is missing/i.test(m));
    check(pixelErrors.length === 0, "コンソールに 'pixel data is missing' が出ない", pixelErrors.slice(0, 2));
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

/** 2D Viewer を開く。web は新規タブ（window.open）か同一タブ遷移のどちらもあり得る。 */
async function openViewer(page: Page, base: string): Promise<Page> {
  const ctx = page.context();
  const before = ctx.pages().length;
  await page.getByTestId("viewer2d-toolbar-button").click();
  for (let i = 0; i < 20; i++) {
    const opened = ctx.pages().find((p) => p !== page && p.url().includes("2dviewer"));
    if (opened) {
      await opened.waitForLoadState("domcontentloaded");
      return opened;
    }
    if (page.url().includes("2dviewer")) return page;
    await page.waitForTimeout(500);
  }
  void before;
  // どちらでもなければ直接遷移する（フォールバック）。
  await page.goto(`${base}/#2dviewer`, { waitUntil: "domcontentloaded" });
  return page;
}

await main();

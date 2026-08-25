/*
 * host API H35〜H39（fw/plugin-architecture.md §7 ／ fw/angio-design.md §22.3）の実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/angioHostApiCheck.ts
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend ＋ 本物のプラグイン配信経路）:
 *   1. H35 校正の**出自**が取れる。**未校正のとき mm/px は null**（検出器面の値で埋めない）
 *   2. H36 XA の状態が取れる。**DSA を掛けると isSubtracted が反転**し、マスクが載る
 *   3. H37 計測値が **本体と同じ SR** になる。`[Plugin] ` 接頭辞と出所（版）が DICOM に入る
 *   4. H38 表示状態が **XA/XRF GSPS（11.5）** として保存される
 *   5. H39 レポートの登録簿に積める。**注意書きが空なら拒否**
 *   6. 🔴 **開いていない SOP を渡すと拒否される**（他患者の検査へ書けない）— H37 / H39 の両方
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）と
 *       fixture xa-angio（`npx tsx src/cli.ts check-fixtures`）。
 *       検証用プラグインは `automator/plugins/angio-hostapi-check/` が原本。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const PLUGIN_ID = "angio-hostapi-check";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "angio-hostapi-check");

interface Calib {
  tileId: string;
  imageId: string;
  mmPerPxRow: number | null;
  mmPerPxCol: number | null;
  source: string;
  confidence: string;
  tier: string;
  plane: string;
  provenance: string;
  warnings: string[];
  detectorMmPerPx: number | null;
}
interface XaState {
  tileId: string;
  imageId: string;
  isSubtracted: boolean;
  maskFrames: number[];
  shift: [number, number];
  logarithmic: boolean;
  pixelIntensityRelationship: string | null;
  frameIndex: number;
  frameCount: number;
}
interface SaveResult {
  ok: boolean;
  cancelled?: boolean;
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
  error?: string;
}
interface Payload {
  api?: Record<string, boolean>;
  context?: {
    seriesUid: string | null;
    sopUid: string | null;
    frameNumber: number;
    tileId: string | null;
    modality: string | null;
    studyDate: string | null;
    roiCount: number;
  };
  calib?: Calib | null;
  xa?: XaState | null;
  calibUnknown?: Calib | null | "missing";
  xaUnknown?: XaState | null | "missing";
  publish?: { ok: boolean; error?: string };
  publishNoCaveats?: { ok: boolean; error?: string };
  publishBadSop?: { ok: boolean; error?: string };
  sr?: SaveResult;
  srUnit?: string;
  srBadSop?: SaveResult;
  gsps?: SaveResult;
  gspsHadMask?: boolean;
}

interface SeriesRow {
  seriesInstanceUid: string;
  seriesDescription?: string;
  modality?: string;
  numberOfInstances?: number;
}

function installVerificationPlugin(): void {
  const src = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, name), path.join(dst, name));
  }
  console.log(`検証用プラグインを配置: ${dst}`);
}

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

async function listSeries(httpPort: number, studyUid: string): Promise<SeriesRow[]> {
  const res = await fetch(`http://localhost:${httpPort}/api/studies/${encodeURIComponent(studyUid)}/series`);
  if (!res.ok) throw new Error(`series list failed: ${res.status}`);
  return (await res.json()) as SeriesRow[];
}

async function instanceTags(
  httpPort: number,
  studyUid: string,
  seriesUid: string,
): Promise<Array<{ name?: string; value?: string }>> {
  const base = `http://localhost:${httpPort}/api/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}`;
  const insts = (await (await fetch(`${base}/instances`)).json()) as Array<{ sopInstanceUid: string }>;
  const sop = insts[0]?.sopInstanceUid;
  if (!sop) throw new Error("no instance in created series");
  return (await (await fetch(`${base}/instances/${encodeURIComponent(sop)}/tags`)).json()) as Array<{
    name?: string;
    value?: string;
  }>;
}

function tagValue(tags: Array<{ name?: string; value?: string }>, name: string): string | undefined {
  return tags.find((t) => (t.name ?? "").toLowerCase() === name.toLowerCase())?.value;
}

/** プラグインを 1 モードだけ走らせる（保存系のダイアログ応答は呼び出し側の責任）。 */
function runPlugin(viewerPage: Page, mode: string, waitKey: keyof Payload): Promise<Payload> {
  return (async () => {
    await viewerPage.evaluate((m) => {
      delete (window as unknown as { __angioHostApiCheck?: unknown }).__angioHostApiCheck;
      (window as unknown as { __angioCheckMode?: string }).__angioCheckMode = m;
    }, mode);
    await viewerPage.getByTestId("viewer2d-menu-plugins").click();
    await viewerPage.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    await viewerPage.waitForFunction(
      (k) => {
        const p = (window as unknown as { __angioHostApiCheck?: Record<string, unknown> }).__angioHostApiCheck;
        return !!p && p[k as string] !== undefined;
      },
      waitKey,
      { timeout: 60_000 },
    );
    return viewerPage.evaluate(
      () => (window as unknown as { __angioHostApiCheck: Payload }).__angioHostApiCheck,
    ) as Promise<Payload>;
  })();
}

/**
 * ROI メニューから「長さ」を選ぶ。
 *
 * <p>⚠️ 直前にプラグインメニューを開いていると、メニューバーのクリックは**開いている
 * メニューを閉じるだけ**で ROI が開かない（実機で踏んだ）。Escape で閉じてから開き、
 * 出なければもう一度押す。
 */
async function selectLengthTool(page: Page): Promise<void> {
  // ⚠️ すでに選択されている項目は名前が「✓ 長さ」になる（checked 表示）。
  //    `^長さ$` で引くと**2 回目以降だけ**見つからない（実機で踏んだ）。
  const item = page.getByRole("button", { name: /^(✓\s*)?(長さ|Length)$/ });
  await page.keyboard.press("Escape").catch(() => undefined);
  for (let i = 0; i < 3; i++) {
    await page.getByTestId("viewer2d-menu-roi").click();
    try {
      await item.first().waitFor({ state: "visible", timeout: 2000 });
      await item.first().click();
      await page.waitForTimeout(300);
      return;
    } catch {
      await page.keyboard.press("Escape").catch(() => undefined);
    }
  }
  throw new Error("ROI メニューの「長さ」を選べませんでした");
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installVerificationPlugin();
  const driver = new DesktopDriver();
  const recorder = createStepRecorder();
  await driver.start();
  let viewerPage: Page | null = null;
  try {
    await resetDb(driver.ports.http);
    const imported = await importFixtureCategory(driver.ports.http, "xa-angio");
    console.log(`fixture import: ${JSON.stringify(imported)}`);

    const mainPage = driver.page;
    mainPage.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
    });
    try {
      await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      console.log(`  MainScreen が出ないので reload して待ち直す（url=${mainPage.url()}）`);
      await mainPage.reload({ waitUntil: "domcontentloaded" });
      await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    }
    await openFirstSeriesInViewer(mainPage, recorder);
    viewerPage = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewerPage.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 15_000 });
    await viewerPage.waitForTimeout(2500);
    viewerPage.on("console", (m) => {
      if (m.type() === "error") console.log(`  [viewer error] ${m.text()}`);
    });

    // 参照 SOP を得るために長さ計測を 1 本引く（実際の使い方と同じ経路）。
    await selectLengthTool(viewerPage);
    check(true, "ROI メニューから「長さ」を選べる");
    await dragOnCanvasHost(viewerPage, "viewer2d-canvas-host", 90, 40, 0, 10, { fracX: 0.3, fracY: 0.35 });
    await viewerPage.waitForTimeout(600);
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "0-length.png") });

    // --- [1] H35 / H36（非サブトラクション） ---
    console.log("\n[1] H35 getSpatialCalibration() / H36 getXaState()");
    const read = await runPlugin(viewerPage, "read", "calib");
    console.log(JSON.stringify({ api: read.api, context: read.context, calib: read.calib, xa: read.xa }, null, 2));
    check(read.api?.getSpatialCalibration === true, "H35 が host に生えている");
    check(read.api?.getXaState === true, "H36 が host に生えている");
    check(read.api?.saveAngioReport === true, "H37 が host に生えている");
    check(read.api?.savePresentationState === true, "H38 が host に生えている");
    check(read.api?.publishAnalysisResult === true, "H39 が host に生えている");
    check(read.context?.modality === "XA" || read.context?.modality === "XRF", "XA/XRF のシリーズを開いている", read.context?.modality);
    check((read.context?.roiCount ?? 0) > 0, "長さ計測が 1 本描けている", read.context?.roiCount);
    check(!!read.context?.sopUid, "🔴 長さ計測から参照 SOP が取れる（XA のフレーム imageId でも）", read.context?.sopUid);
    check(
      /^\d{4}-\d{2}-\d{2}$/.test(read.context?.studyDate ?? ""),
      "XA でも studyDate が ISO 日付で取れる（H6）",
      read.context?.studyDate,
    );

    const calib = read.calib;
    check(!!calib, "H35 が校正を返す（XA なので null にしない）", calib);
    check(!!calib?.provenance, "出自の文字列が空でない", calib?.provenance);
    check(["calibrated", "approximate", "uncalibrated"].includes(calib?.tier ?? ""), "tier が既定の 3 値", calib?.tier);
    if (calib?.tier === "uncalibrated") {
      // 🔴 このフィクスチャ（Rubo の XA）は PixelSpacing も ImagerPixelSpacing も SID/SOD も無い。
      //    ここで検出器面の値を mm/px に流し込んでいないことを確かめる。
      check(calib.mmPerPxRow === null && calib.mmPerPxCol === null, "未校正では mm/px が null（数値で埋めない）", {
        row: calib.mmPerPxRow,
        col: calib.mmPerPxCol,
      });
    } else {
      check((calib?.mmPerPxCol ?? 0) > 0, "校正済みなら mm/px が正の値", calib?.mmPerPxCol);
    }
    check(read.calibUnknown === null, "未知の tileId は null（例外にしない・H35）", read.calibUnknown);
    check(read.xaUnknown === null, "未知の tileId は null（例外にしない・H36）", read.xaUnknown);

    const xa = read.xa;
    check(!!xa, "H36 が XA の状態を返す", xa);
    check(xa?.isSubtracted === false, "DSA を掛ける前は isSubtracted=false", xa?.isSubtracted);
    check((xa?.frameCount ?? 0) > 1, "マルチフレーム（シネ）として展開されている", xa?.frameCount);
    check(xa?.maskFrames.length === 0, "非サブトラクションではマスクが空", xa?.maskFrames);

    // --- [2] H36（DSA を掛けた後） ---
    console.log("\n[2] DSA を掛けて H36 が追従するか");
    await viewerPage.getByTestId("dsa-check").click();
    await viewerPage.getByTestId("dsa-mask").waitFor({ state: "visible", timeout: 30_000 });
    await viewerPage.waitForTimeout(1500);
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "1-dsa.png") });
    const dsaRead = await runPlugin(viewerPage, "read", "calib");
    console.log(JSON.stringify(dsaRead.xa, null, 2));
    check(dsaRead.xa?.isSubtracted === true, "🔴 DSA 表示中は isSubtracted=true（差分と気付ける）", dsaRead.xa?.isSubtracted);
    check((dsaRead.xa?.maskFrames.length ?? 0) > 0, "マスクフレームが載る", dsaRead.xa?.maskFrames);
    check(!!dsaRead.calib, "DSA 合成中でも校正が読める（合成 imageId から解決できる）", dsaRead.calib?.source);
    // ⚠️ DSA を掛けるとスタックの identity が変わるので、**掛ける前に引いた計測は
    //    プラグインからは見えなくなる**（本体の解析ダイアログも同じ扱い＝
    //    `XaAnalysisDialog.collectLengthPicks` が表示中 imageId で絞る）。
    //    「差分を見ながら測る」なら差分の上で引き直すのが正しい運用。ここではそれを固定する。
    check(dsaRead.context?.roiCount === 0, "DSA 前に引いた計測は差分表示では見えない（本体と同じ扱い）", dsaRead.context?.roiCount);

    // 差分の上で引き直す（以降の保存はこの計測を参照する）。
    await selectLengthTool(viewerPage);
    await dragOnCanvasHost(viewerPage, "viewer2d-canvas-host", 70, 50, 0, 10, { fracX: 0.45, fracY: 0.55 });
    await viewerPage.waitForTimeout(800);
    const dsaDrawn = await runPlugin(viewerPage, "read", "calib");
    check(dsaDrawn.context?.roiCount === 1, "差分の上で引き直した計測は見える", dsaDrawn.context?.roiCount);
    check(!!dsaDrawn.context?.sopUid, "差分表示中でも参照 SOP が取れる（合成 imageId から解決）", dsaDrawn.context?.sopUid);
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "1b-dsa-length.png") });

    // --- [3] H39（レポート登録簿・確認ダイアログなし） ---
    console.log("\n[3] H39 publishAnalysisResult()");
    const rep = await runPlugin(viewerPage, "report", "publish");
    console.log(JSON.stringify({ publish: rep.publish, noCaveats: rep.publishNoCaveats, badSop: rep.publishBadSop }, null, 2));
    check(rep.publish?.ok === true, "正常な記録は登録できる", rep.publish);
    check(rep.publishNoCaveats?.ok === false, "🔴 注意書きが空（空白のみ）なら拒否", rep.publishNoCaveats);
    check(rep.publishBadSop?.ok === false, "🔴 開いていない SOP を参照する記録は拒否", rep.publishBadSop);

    // --- [4] H37（SR。確認ダイアログあり） ---
    console.log("\n[4] H37 saveAngioReport()");
    const studyUid = read.context?.seriesUid ? await studyOf(driver.ports.http, read.context.seriesUid) : null;
    const before = studyUid ? await listSeries(driver.ports.http, studyUid) : [];

    // 4-1) 拒否できること。
    const cancelPromise = runPlugin(viewerPage, "sr", "sr");
    await viewerPage.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 20_000 });
    check(true, "保存前に確認ダイアログが出る（抑止不可）");
    const dlgText = (await viewerPage.getByTestId("plugin-save-confirm").textContent())?.replace(/\s+/g, " ") ?? "";
    check(dlgText.includes("Angio Host API Check") && dlgText.includes("0.1.0"), "ダイアログにプラグイン名と版が出る", dlgText.slice(0, 120));
    const shownAnalysis = (await viewerPage.getByTestId("plugin-save-analysis").textContent())?.trim() ?? "";
    check(shownAnalysis.length > 0, "どの解析を保存するかが出る（件数ではなく名前）", shownAnalysis);
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "2-sr-confirm.png") });
    await viewerPage.getByTestId("plugin-save-cancel").click();
    const cancelled = await cancelPromise;
    check(cancelled.sr?.cancelled === true, "拒否すると cancelled が返る", cancelled.sr);
    const afterCancel = studyUid ? await listSeries(driver.ports.http, studyUid) : [];
    check(afterCancel.length === before.length, "拒否したときシリーズは作られない", { before: before.length, after: afterCancel.length });

    // 4-2) 承諾して保存。
    const savePromise = runPlugin(viewerPage, "sr", "sr");
    await viewerPage.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 20_000 });
    await viewerPage.getByTestId("plugin-save-confirm-button").click();
    const saved = await savePromise;
    console.log(JSON.stringify({ sr: saved.sr, unit: saved.srUnit }, null, 2));
    check(saved.sr?.ok === true, "承諾すると SR が保存される", saved.sr);
    check(saved.srUnit === "px", "未校正のフィクスチャでは px のまま出す（mm を騙らない）", saved.srUnit);

    if (studyUid && saved.sr?.seriesInstanceUid) {
      const after = await listSeries(driver.ports.http, studyUid);
      const created = after.find((x) => x.seriesInstanceUid === saved.sr?.seriesInstanceUid);
      check(!!created, "保管庫のシリーズ一覧に現れる（本当に DICOM になった）", saved.sr?.seriesInstanceUid);
      check((created?.seriesDescription ?? "").startsWith("[Plugin] "), "SeriesDescription に [Plugin] 接頭辞", created?.seriesDescription);
      check(created?.modality === "SR", "モダリティが SR", created?.modality);
      const tags = await instanceTags(driver.ports.http, studyUid, saved.sr.seriesInstanceUid);
      const model = tagValue(tags, "ManufacturerModelName") ?? JSON.stringify(tags.slice(0, 3));
      check(
        JSON.stringify(tags).includes("Angio Host API Check"),
        "ContributingEquipment にプラグイン名が入る（誰が計算したかが残る）",
        model,
      );
    }

    // 4-3) 開いていない SOP は拒否（同意しても書けない）。
    const badPromise = runPlugin(viewerPage, "sr-bad", "srBadSop");
    await viewerPage.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 20_000 });
    await viewerPage.getByTestId("plugin-save-confirm-button").click();
    const bad = await badPromise;
    check(bad.srBadSop?.ok === false, "🔴 開いていない SOP は同意しても拒否（他患者の検査へ書けない）", bad.srBadSop);

    // --- [5] H38（GSPS。確認ダイアログあり） ---
    console.log("\n[5] H38 savePresentationState()");
    const gspsPromise = runPlugin(viewerPage, "gsps", "gsps");
    await viewerPage.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 20_000 });
    const psText = (await viewerPage.getByTestId("plugin-save-confirm").textContent())?.replace(/\s+/g, " ") ?? "";
    check(/表示状態|presentation state/i.test(psText), "GSPS 用の文言になっている（計測レポートと混ぜない）", psText.slice(0, 120));
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "3-gsps-confirm.png") });
    await viewerPage.getByTestId("plugin-save-confirm-button").click();
    const gsps = await gspsPromise;
    console.log(JSON.stringify({ gsps: gsps.gsps, hadMask: gsps.gspsHadMask }, null, 2));
    check(gsps.gsps?.ok === true, "承諾すると表示状態が保存される", gsps.gsps);
    check(gsps.gspsHadMask === true, "DSA 中なのでマスクを載せて保存した", gsps.gspsHadMask);

    if (studyUid && gsps.gsps?.seriesInstanceUid) {
      const after = await listSeries(driver.ports.http, studyUid);
      const created = after.find((x) => x.seriesInstanceUid === gsps.gsps?.seriesInstanceUid);
      check(!!created, "保管庫のシリーズ一覧に現れる", gsps.gsps?.seriesInstanceUid);
      check((created?.seriesDescription ?? "").startsWith("[Plugin] "), "SeriesDescription に [Plugin] 接頭辞", created?.seriesDescription);
      check(created?.modality === "PR", "モダリティが PR（表示状態）", created?.modality);
      const tags = await instanceTags(driver.ports.http, studyUid, gsps.gsps.seriesInstanceUid);
      const sopClass = tagValue(tags, "SOPClassUID") ?? "";
      check(
        JSON.stringify(tags).includes("1.2.840.10008.5.1.4.1.1.11.5"),
        "🔴 XA/XRF GSPS（11.5）で書かれている（DSA を保存できる唯一の器）",
        sopClass,
      );
      check(
        JSON.stringify(tags).includes("Angio Host API Check"),
        "ContributingEquipment にプラグイン名が入る",
      );
    }

    await viewerPage.screenshot({ path: path.join(OUT_DIR, "4-final.png") });
  } finally {
    if (viewerPage) {
      try {
        await viewerPage.screenshot({ path: path.join(OUT_DIR, "9-last.png") });
      } catch {
        /* ignore */
      }
    }
    await driver.stop();
  }

  console.log(`\n===== 合格 ${passed} / 不合格 ${failures.length} =====`);
  for (const f of failures) console.log(`  - ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

/** シリーズ UID → スタディ UID（検索 API から引く）。 */
async function studyOf(httpPort: number, seriesUid: string): Promise<string | null> {
  const res = await fetch(`http://localhost:${httpPort}/api/studies?limit=50`);
  if (!res.ok) return null;
  const studies = (await res.json()) as Array<{ studyInstanceUid: string }>;
  for (const s of studies) {
    const list = await listSeries(httpPort, s.studyInstanceUid);
    if (list.some((x) => x.seriesInstanceUid === seriesUid)) return s.studyInstanceUid;
  }
  return null;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

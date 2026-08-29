/*
 * QCA の**解析状態の保存と復元**（§14.5）と、**ROI 選択の区別**（§8.7.1）の実機検証
 * — `fw/angio-design.md`。
 *
 * 実行:  cd automator && npx tsx src/spike/xaQcaRestoreCheck.ts
 *
 * <h3>ここで何を確かめるか</h3>
 * 単体テスト（`qcaAnalysisState.test.ts`）は保存形の往復しか見ていない。**ダイアログが
 * 実際に書いて・読んで・当てているか**は画面からしか分からない。とくに:
 *
 * - 保存したものが**保管庫に本当に入っているか**（backend を直接読んで確かめる）
 * - 開き直したときに**手修正込みで**戻るか（数値で突き合わせる）
 * - 🔴 **「手修正をすべて破棄」した直後に復元が勝って元に戻らないか**
 *   ——ここが壊れると「何をしても戻ってくる」という最悪の壊れ方になる
 * - 「上書き」で前の SR が**実際に消えるか**（増え続けていないか）
 *
 * 🚨 **「保存しました」の文字を合格条件にしない。** 保存の成否は保管庫の中身で見る。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-qca-restore");
const XA_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "xa-angio");
const SAMPLE = "0002.DCM";
const HOST = "viewer2d-canvas-host";
const FRAME = 55;

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

interface QcaState {
  imageId: string;
  centerline: [number, number][];
  edges: { left: [number, number]; right: [number, number] }[];
  pathIndices: number[];
  centerlineToken: string;
  provenance: { waypoints: number; editedEdges: number[]; trimmed: boolean; reference: string; edited: boolean };
  mld: number;
  rvd: number;
  points: number;
  unit: string;
  view: { cx0: number; cy0: number; cw: number; ch: number; scale: number; dw: number; dh: number } | null;
}

/** 保管庫に入っている解析状態（backend を直接読む）。 */
interface StoredAnalysis {
  id: string;
  mode: string;
  frame: number;
  pickUid: string;
  edgeToken: string | null;
  waypoints: [number, number][];
  edgeEdits: Record<string, { left?: number; right?: number }>;
  trim: { from: number; to: number } | null;
  reference: { kind: string };
  sr: { seriesInstanceUid: string; sopInstanceUid: string } | null;
  savedAt: string;
}

async function qcaState(page: Page): Promise<QcaState | null> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { __graphyDebug?: { getQcaState?: () => unknown } }).__graphyDebug;
    return (dbg?.getQcaState?.() ?? null) as unknown;
  }) as Promise<QcaState | null>;
}

async function selectedAnnotations(page: Page): Promise<string[]> {
  const raw = (await page.evaluate(`(function () {
    var g = window.__graphyDebug;
    return JSON.stringify(g && g.getSelectedAnnotations ? g.getSelectedAnnotations() : []);
  })()`)) as string;
  return JSON.parse(raw) as string[];
}

/** 画像 px → 拡大パネル上のクライアント座標。 */
async function panelPoint(page: Page, st: QcaState, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("qca-editor-canvas").boundingBox();
  if (!box || !st.view) throw new Error("拡大パネルが見つかりません");
  return {
    x: box.x + ((x - st.view.cx0) / st.view.cw) * box.width,
    y: box.y + ((y - st.view.cy0) / st.view.ch) * box.height,
  };
}

async function studies(
  httpPort: number,
): Promise<{ studyInstanceUid: string; patientId: string | null; patientName: string | null }[]> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/studies`);
  return (await res.json()) as { studyInstanceUid: string; patientId: string | null; patientName: string | null }[];
}

async function listSeries(httpPort: number, studyUid: string) {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/studies/${encodeURIComponent(studyUid)}/series`);
  return (await res.json()) as { seriesInstanceUid: string; modality: string | null; seriesDescription: string | null }[];
}

/**
 * 保管庫の解析状態を読む。
 *
 * <p>患者キーはフロントの規則（PatientID → PatientName → StudyInstanceUID）なので、
 * **順に試す**。ここを決め打ちにすると、キーが違うだけで「保存されていない」と読める。
 */
async function storedAnalyses(
  httpPort: number,
  candidates: string[],
): Promise<{ key: string; analyses: StoredAnalysis[]; rois: number } | null> {
  for (const key of candidates) {
    if (!key) continue;
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/rois?patientKey=${encodeURIComponent(key)}`);
    if (!res.ok) continue;
    const dto = (await res.json()) as { json?: string | null };
    if (!dto.json) continue;
    const file = JSON.parse(dto.json) as { rois?: unknown[]; analyses?: StoredAnalysis[] };
    const analyses = file.analyses ?? [];
    if (analyses.length) return { key, analyses, rois: file.rois?.length ?? 0 };
  }
  return null;
}

/** 手修正を 1 つ入れる（中間点）。★入ったことを数値で確かめてから先へ進む。 */
async function addWaypoint(viewer: Page, dy: number): Promise<QcaState> {
  await viewer.getByTestId("xa-qca-mode-waypoint").click();
  await viewer.waitForTimeout(400);
  // 🚨 **触る直前に必ずスクロールし直す**（§18-2）。拡大パネルはダイアログのスクロール領域の
  //    中にあり、`boundingBox()` は隠れている部分も返す。そのまま座標を作るとクリックが
  //    スクロール容器へ落ち、掴めないのにエラーも出ない。ストレート像が下に付いて
  //    ダイアログが更に縦長になったので、なお踏みやすい。
  await viewer.getByTestId("qca-editor-canvas").scrollIntoViewIfNeeded();
  await viewer.waitForTimeout(300);
  const st = (await qcaState(viewer))!;
  const mid = st.centerline[Math.floor(st.centerline.length / 2)];
  const p = await panelPoint(viewer, st, mid[0], mid[1] + dy);
  await viewer.mouse.click(p.x, p.y);
  await viewer.waitForTimeout(2_500);
  return (await qcaState(viewer))!;
}

async function openDialog(viewer: Page): Promise<void> {
  await viewer.getByTestId("xa-analysis-open").click();
  await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });
}

async function closeDialog(viewer: Page): Promise<void> {
  await viewer.getByTestId("xa-dialog-close").click();
  await viewer.waitForTimeout(800);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sample = path.join(XA_DIR, SAMPLE);
  if (!fs.existsSync(sample)) {
    throw new Error(`XA サンプルがありません: ${sample}\n  bash automator/scripts/fetch-xa-samples.sh で取得してください。`);
  }

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [sample]);
    if (imp.imported !== 1) throw new Error(`取込に失敗: ${JSON.stringify(imp)}`);
    const all = await studies(driver.ports.http);
    const study = all[0];
    // 患者キーはフロントの規則（PatientID → PatientName → StudyInstanceUID）。順に試す。
    const keyCandidates = [study.patientId ?? "", study.patientName ?? "", study.studyInstanceUid];
    const seriesBefore = await listSeries(driver.ports.http, study.studyInstanceUid);

    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    mainPage.once("dialog", (d) => void d.accept());
    const dateInputs = mainPage.locator('input[type="date"]');
    await dateInputs.nth(0).fill("");
    await dateInputs.nth(1).fill("");
    await mainPage.getByTestId("search-submit-button").click();
    await mainPage.locator('[data-testid^="study-row-"]').first().click();
    await mainPage.locator('[data-testid^="series-row-"]').first().click();

    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);
    await viewer.getByTestId("cine-seek").fill(String(FRAME));
    await viewer.waitForTimeout(1_500);

    // 🚨 **線は最初にまとめて 2 本引く。** ROI メニューを 2 回開こうとしたら 2 回目が開かず
    //    落ちた（1 回目で選んだツールは残るので、開き直す必要がそもそも無い）。
    //    1 本目 = 解析区間（狭窄を挟む長い線・一覧の #1）、
    //    2 本目 = 校正用（カテーテルの太さを横切る短い直線・一覧の #2）。
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.waitForTimeout(300);
    await viewer.getByText("長さ", { exact: true }).first().click();
    await viewer.waitForTimeout(400);
    await dragOnCanvasHost(viewer, HOST, 90, 60, 0, 12, { fracX: 0.42, fracY: 0.35 });
    await viewer.waitForTimeout(1_200);
    await dragOnCanvasHost(viewer, HOST, 18, 0, 0, 6, { fracX: 0.62, fracY: 0.62 });
    await viewer.waitForTimeout(1_200);

    await openDialog(viewer);
    check(
      (await viewer.getByTestId("xa-analysis-restored").count()) === 0,
      "[R1] まだ何も保存していないので「復元しました」は出ない",
    );
    await viewer.getByTestId("xa-qca-run").click();
    await viewer.waitForTimeout(6_000);
    const auto = (await qcaState(viewer))!;
    check(auto.points > 10, "[R2] 自動解析が結果を返す", { points: auto.points, mld: auto.mld });

    // ── 手修正を入れる ────────────────────────────────────────────
    const edited = await addWaypoint(viewer, 10);
    check(edited.provenance.waypoints === 1, "[R3a] ★中間点が入った", edited.provenance.waypoints);
    check(edited.centerlineToken !== auto.centerlineToken, "[R3b] ★中心線が変わった（手修正が効いている）");
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-edited.png") }).catch(() => {});

    // ── 保存（前の SR は無いので選択は出ない）────────────────────
    check(
      (await viewer.getByTestId("xa-save-sr-choice").count()) === 0,
      "[R4a] 初回は「上書き / 新規」を聞かない（前の SR が無い）",
    );
    await viewer.getByTestId("xa-save-sr").click();
    await viewer.waitForTimeout(1_000);
    check(
      (await viewer.getByTestId("xa-save-sr-choice").count()) === 0,
      "[R4b] そのまま保存される（選択は出ない）",
    );
    await viewer.waitForTimeout(4_000);
    const afterSave = await listSeries(driver.ports.http, study.studyInstanceUid);
    const srs1 = afterSave.filter((s) => s.modality === "SR" && !seriesBefore.some((b) => b.seriesInstanceUid === s.seriesInstanceUid));
    check(srs1.length === 1, "[R5] SR が 1 本増える", srs1.map((s) => s.seriesDescription));

    // 🚨 「保存しました」の文字ではなく**保管庫の中身**で見る。
    const stored = await storedAnalyses(driver.ports.http, keyCandidates);
    check(!!stored && stored.analyses.length === 1, "[R6a] ★解析状態が保管庫に入っている", {
      key: stored?.key,
      analyses: stored?.analyses.length,
      rois: stored?.rois,
    });
    const a0 = stored?.analyses[0];
    check(a0?.frame === FRAME + 1 || a0?.frame === FRAME, "[R6b] 解析したフレームで鍵が作られている", {
      stored: a0?.frame,
      shown: FRAME,
    });
    check((a0?.waypoints.length ?? 0) === 1, "[R6c] ★中間点が保存されている（入力を残している）", a0?.waypoints);
    check(!!a0?.sr, "[R6d] 書いた SR の参照が入っている（上書きの宛先）", a0?.sr);
    check(a0?.edgeToken === edited.centerlineToken, "[R6e] 中心線の指紋が一緒に残っている", {
      stored: a0?.edgeToken,
      shown: edited.centerlineToken,
    });

    // ── 開き直して復元 ────────────────────────────────────────────
    await closeDialog(viewer);
    await openDialog(viewer);
    await viewer.getByTestId("xa-analysis-restored").waitFor({ state: "visible", timeout: 20_000 });
    check(true, "[R7a] ★開き直すと「保存した解析を復元しました」が出る");
    await viewer.waitForTimeout(6_000);
    const restored = (await qcaState(viewer))!;
    check(
      restored.provenance.waypoints === 1 && restored.provenance.edited,
      "[R7b] ★手修正込みで復元されている",
      restored.provenance,
    );
    check(
      restored.centerlineToken === edited.centerlineToken,
      "[R7c] ★同じ中心線に戻る（入力から作り直せている）",
      { before: edited.centerlineToken, after: restored.centerlineToken },
    );
    check(
      Math.abs(restored.mld - edited.mld) < 1e-6,
      "[R7d] 数値も同じ（保存した数値の表示ではなく、同じ入力での再解析）",
      { before: edited.mld, after: restored.mld },
    );
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-restored.png") }).catch(() => {});

    // 🔴 ここが最重要の見張り。破棄した直後に復元が勝つと「何をしても戻ってくる」になる。
    await viewer.getByTestId("xa-qca-reset").click();
    await viewer.waitForTimeout(5_000);
    const afterReset = (await qcaState(viewer))!;
    check(
      afterReset.provenance.waypoints === 0 && !afterReset.provenance.edited,
      "[R8a] ★「手修正をすべて破棄」で自動に戻る",
      afterReset.provenance,
    );
    await viewer.waitForTimeout(3_000);
    const afterResetLater = (await qcaState(viewer))!;
    check(
      afterResetLater.provenance.waypoints === 0,
      "[R8b] ★破棄したあと復元が勝って戻ってこない（1 つの鍵につき 1 回だけ当てる）",
      afterResetLater.provenance,
    );

    // ── もう一度直して保存 → 上書き / 新規を聞く ─────────────────
    const edited2 = await addWaypoint(viewer, -8);
    check(edited2.provenance.waypoints === 1, "[R9] もう一度手修正を入れた", edited2.provenance.waypoints);
    await viewer.getByTestId("xa-save-sr").click();
    await viewer.waitForTimeout(800);
    check(
      (await viewer.getByTestId("xa-save-sr-choice").count()) === 1,
      "[R10] ★保存済みの SR があるので「上書き / 新規」を聞く",
    );
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-choice.png") }).catch(() => {});

    // 新規で保存 → SR が 2 本になる。
    await viewer.getByTestId("xa-save-sr-new").click();
    await viewer.waitForTimeout(5_000);
    const afterNew = await listSeries(driver.ports.http, study.studyInstanceUid);
    const srs2 = afterNew.filter((s) => s.modality === "SR" && !seriesBefore.some((b) => b.seriesInstanceUid === s.seriesInstanceUid));
    check(srs2.length === 2, "[R11] ★「新規で保存」は前の SR を消さない", srs2.length);

    // 上書き保存 → 本数が増えない（前のが消える）。
    await viewer.getByTestId("xa-save-sr").click();
    await viewer.waitForTimeout(800);
    check((await viewer.getByTestId("xa-save-sr-choice").count()) === 1, "[R12a] もう一度聞かれる");
    await viewer.getByTestId("xa-save-sr-replace").click();
    await viewer.waitForTimeout(6_000);
    const afterReplace = await listSeries(driver.ports.http, study.studyInstanceUid);
    const srs3 = afterReplace.filter((s) => s.modality === "SR" && !seriesBefore.some((b) => b.seriesInstanceUid === s.seriesInstanceUid));
    check(srs3.length === 2, "[R12b] ★「上書き」で本数が増えない（前の版が消える）", {
      before: srs2.length,
      after: srs3.length,
    });
    const stored2 = await storedAnalyses(driver.ports.http, keyCandidates);
    const a1 = stored2?.analyses[0];
    check(
      !!a1?.sr && !srs3.every((s) => s.seriesInstanceUid !== a1.sr!.seriesInstanceUid),
      "[R12c] ★解析状態の SR 参照が、いま残っている SR を指している",
      { sr: a1?.sr?.seriesInstanceUid, alive: srs3.map((s) => s.seriesInstanceUid) },
    );

    // ── §8.7.1 どちらの線を選んでいるか ──────────────────────────
    // 線は最初に 2 本引いてあるので、開いているダイアログのまま見る。
    const options = await viewer.evaluate(`(() => {
      const sel = document.querySelector('[data-testid="xa-analysis-pick"]');
      return sel ? JSON.stringify(Array.from(sel.options).map((o) => o.textContent)) : "[]";
    })()`);
    const labels = JSON.parse(options as string) as string[];
    check(labels.length === 2, "[R13a] 解析区間の一覧に 2 本出る", labels);
    check(
      labels.some((l) => /解析に使用中|used for analysis/.test(l ?? "")),
      "[R13b] ★一覧に用途が出る（どちらに使われている線か分かる）",
      labels,
    );

    // 「画像で示す」で、その線が選択（ハイライト）される。
    await viewer.getByTestId("xa-analysis-pick-show").click();
    await viewer.waitForTimeout(800);
    const sel1 = await selectedAnnotations(viewer);
    check(sel1.length === 1, "[R14a] ★「画像で示す」で 1 本だけ光る", sel1.length);

    // 校正の一覧で別の線を選ぶと、そちらへ移る（排他）。
    await viewer.selectOption('[data-testid="xa-calib-pick"]', "1");
    await viewer.waitForTimeout(800);
    const sel2 = await selectedAnnotations(viewer);
    check(sel2.length === 1 && sel2[0] !== sel1[0], "[R14b] ★選び替えると光る線も移る（前のは消える）", {
      before: sel1,
      after: sel2,
    });

    // 解析区間と同じ線を校正に選ぶと警告する（§8.7 の事故）。
    await viewer.selectOption('[data-testid="xa-calib-pick"]', "0");
    await viewer.waitForTimeout(800);
    check(
      (await viewer.getByTestId("xa-calib-same-as-analysis").count()) === 1,
      "[R15a] ★解析区間と同じ線を校正に選ぶと警告する",
    );
    await viewer.selectOption('[data-testid="xa-calib-pick"]', "1");
    await viewer.waitForTimeout(800);
    check(
      (await viewer.getByTestId("xa-calib-same-as-analysis").count()) === 0,
      "[R15b] 別の線に戻すと警告が消える",
    );
    await viewer.screenshot({ path: path.join(OUT_DIR, "4-picks.png") }).catch(() => {});
  } finally {
    await driver.stop();
  }

  console.log(`\n===== QCA 解析状態の保存・復元（§14.5）／ROI 選択の区別（§8.7.1）=====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) {
    console.log("失敗した項目:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
  console.log(`スクリーンショット: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

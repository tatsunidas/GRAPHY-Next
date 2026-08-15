/*
 * QLV（左室造影の定量解析・A5b）の実機検証 — `fw/angio-design.md` §9.2 / §21。
 *
 * 実行:  cd automator && npx tsx src/spike/xaQlvCheck.ts
 *
 * <h3>実データに真値は無い。それでも数値で判定できる理由</h3>
 * `0009.DCM`（Rubo・左室造影・RAO 30°・137 フレーム）には EF の真値が無い。
 * しかし **ES 輪郭を ED 輪郭の k 倍に取れば、EF は形状によらず厳密に 1 − k³ になる**:
 *
 *   Area-Length: V = 8A²/(3πL)。全体を k 倍すると A→k²A, L→kL なので V→k⁴/k = k³V。
 *   よって EF = 1 − ESV/EDV = 1 − k³。**校正の有無にも輪郭の形にも依らない。**
 *
 * これで「動いた」ではなく**数値**で判定できる（§9.2.1 の主張そのものを実機で確かめる）。
 * 平滑化（Catmull-Rom）はアフィン変換と可換なので、平滑化後も等式は保たれる。
 *
 * ⚠️ automator を回す前に `cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`
 *    （QLV SR のエンドポイントは backend 側の新規実装）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs, findBlockingOverlay } from "../common/dismissDialogs.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-qlv");
const XA_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "xa-angio");
/** 左室造影（ピッグテイル＋ LV 内腔の造影・RAO 30°・137 フレーム）。§21.3 で中身を確認済み。 */
const SAMPLE = "0009.DCM";
/** ES を ED の何倍にするか。EF の期待値 = 1 − k³。 */
const SHRINK = 0.8;
const EXPECTED_EF = (1 - SHRINK ** 3) * 100; // 48.8 %
/** クリック誤差（画素丸め）ぶんの許容。 */
const EF_TOL = 2.0;

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

interface QlvState {
  edFrame: number;
  esFrame: number;
  framesManual: boolean;
  frameWarnings: string[];
  areaCurve: number[];
  edPoints: number;
  esPoints: number;
  result: {
    ejectionFraction: number;
    edvMl: number | null;
    esvMl: number | null;
    edVolumePx3: number;
    esVolumePx3: number;
    edAreaPx2: number;
    esAreaPx2: number;
    edLongAxisPx: number;
    kennedyEf: number | null;
    unit: string;
    warnings: string[];
    wallMotion: number[] | null;
    wallMotionMethod: string | null;
  } | null;
  view: { cx0: number; cy0: number; cw: number; ch: number; scale: number; dw: number; dh: number } | null;
}

async function qlvState(page: Page): Promise<QlvState | null> {
  return page.evaluate(`(() => {
    const dbg = window.__graphyDebug;
    return (dbg && dbg.getQlvState ? dbg.getQlvState() : null);
  })()`) as Promise<QlvState | null>;
}

/** レール上の段の状態（`data-state`）。色や記号では判定しない。 */
async function railStates(page: Page): Promise<Record<string, string>> {
  return page.evaluate(`(() => {
    const out = {};
    document.querySelectorAll('[data-testid][data-state]').forEach((el) => {
      const id = el.getAttribute('data-testid');
      if (id && id.indexOf('xa-step-') === 0) out[id.slice('xa-step-'.length)] = el.getAttribute('data-state');
    });
    return out;
  })()`) as Promise<Record<string, string>>;
}

/** 画像 px → 輪郭パネル上のクライアント座標。 */
async function panelPoint(page: Page, st: QlvState, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("lv-contour-canvas").boundingBox();
  if (!box || !st.view) throw new Error("輪郭パネルが見つかりません");
  return {
    x: box.x + ((x - st.view.cx0) / st.view.cw) * box.width,
    y: box.y + ((y - st.view.cy0) / st.view.ch) * box.height,
  };
}

/**
 * 左室らしい位置に楕円の点列を作る（弁輪の一端 → 心尖 → 他端 の順）。
 * ⚠️ 位置の妥当性はここでは問わない。EF の等式は形にも位置にも依らないため。
 */
function ellipsePoints(cx: number, cy: number, a: number, b: number, n: number): [number, number][] {
  const cut = 0.55; // 弁面ぶんを空ける
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const th = cut + ((2 * Math.PI - 2 * cut) * i) / (n - 1);
    out.push([cx + b * Math.sin(th), cy - a * Math.cos(th)]);
  }
  return out;
}

/** 重心まわりに k 倍する。EF = 1 − k³ の等式を作るため。 */
function scaleAbout(pts: [number, number][], k: number): [number, number][] {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return pts.map((p) => [cx + (p[0] - cx) * k, cy + (p[1] - cy) * k] as [number, number]);
}

async function clickContour(page: Page, st: QlvState, pts: [number, number][]): Promise<void> {
  for (const p of pts) {
    const c = await panelPoint(page, st, p[0], p[1]);
    await page.mouse.click(c.x, c.y);
    await page.waitForTimeout(120);
  }
}

async function listSeries(httpPort: number, studyUid: string) {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/studies/${encodeURIComponent(studyUid)}/series`);
  return (await res.json()) as { seriesInstanceUid: string; modality: string | null; seriesDescription: string | null }[];
}

async function instancesOf(httpPort: number, studyUid: string, seriesUid: string): Promise<string[]> {
  const url =
    `http://127.0.0.1:${httpPort}/api/studies/${encodeURIComponent(studyUid)}` +
    `/series/${encodeURIComponent(seriesUid)}/instances`;
  const res = await fetch(url);
  const rows = (await res.json()) as { sopInstanceUid: string }[];
  return rows.map((r) => r.sopInstanceUid);
}

async function dumpTags(httpPort: number, studyUid: string, seriesUid: string, sopUid: string): Promise<string> {
  const url =
    `http://127.0.0.1:${httpPort}/api/studies/${encodeURIComponent(studyUid)}` +
    `/series/${encodeURIComponent(seriesUid)}/instances/${encodeURIComponent(sopUid)}/tags`;
  const res = await fetch(url);
  if (!res.ok) return "";
  const rows = (await res.json()) as { name: string; value: string }[];
  return rows.map((r) => `${r.name}=${r.value}`).join("\n");
}

async function firstStudyUid(httpPort: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/studies`);
  const studies = (await res.json()) as { studyInstanceUid: string }[];
  if (!studies.length) throw new Error("スタディがありません");
  return studies[0].studyInstanceUid;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sample = path.join(XA_DIR, SAMPLE);
  if (!fs.existsSync(sample)) throw new Error(`左室造影のサンプルがありません: ${sample}`);

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [sample]);
    if (imp.imported !== 1) throw new Error(`取込に失敗: ${JSON.stringify(imp)}`);
    const studyUid = await firstStudyUid(driver.ports.http);
    const seriesBefore = await listSeries(driver.ports.http, studyUid);

    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    const blocked = await findBlockingOverlay(mainPage, "search-submit-button");
    if (blocked) throw new Error(`クリックが塞がれています: ${blocked}`);
    mainPage.once("dialog", (d) => void d.accept());
    const dateInputs = mainPage.locator('input[type="date"]');
    await dateInputs.nth(0).fill("");
    await dateInputs.nth(1).fill("");
    await mainPage.getByTestId("search-submit-button").click();
    await mainPage.getByTestId(`study-row-${studyUid}`).click();
    await mainPage.locator('[data-testid^="series-row-"]').first().click();

    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);

    // ── 条件 1: 導線とダイアログ ───────────────────────────────────
    const openVisible = await viewer.getByTestId("qlv-open").isVisible().catch(() => false);
    check(openVisible, "[1a] XA シリーズに LV 解析の導線が出る");
    await viewer.getByTestId("qlv-open").click();
    await viewer.getByTestId("qlv-dialog").waitFor({ state: "visible", timeout: 10_000 });
    // 造影面積の時系列を作るのに全フレーム読むので待つ。
    await viewer.waitForTimeout(15_000);
    const st0 = await qlvState(viewer);
    check(!!st0, "[1b] QLV の状態を取得できる");
    if (!st0) throw new Error("QLV の状態を取得できませんでした");
    check(st0.areaCurve.length >= 3, "[1c] 造影面積の時系列を作れる", { n: st0.areaCurve.length });
    check(
      st0.edFrame >= 0 && st0.esFrame >= 0 && st0.edFrame !== st0.esFrame,
      "[1d] ED/ES が提案される（同じフレームにならない）",
      { ed: st0.edFrame, es: st0.esFrame },
    );
    // ★提案の中身を数値で確かめる: ED は ES より造影面積が大きいはず。
    const curveAt = (frame: number) =>
      st0.areaCurve[Math.min(st0.areaCurve.length - 1, Math.round((frame / 136) * (st0.areaCurve.length - 1)))];
    check(curveAt(st0.edFrame) > curveAt(st0.esFrame), "[1e] ★ED の造影面積が ES より大きい", {
      ed: curveAt(st0.edFrame),
      es: curveAt(st0.esFrame),
    });
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-frames.png") }).catch(() => {});

    // ── 条件 2: 段が QCA と違う ────────────────────────────────────
    const rail = await railStates(viewer);
    check(
      JSON.stringify(Object.keys(rail)) ===
        JSON.stringify(["frames", "calibration", "edContour", "esContour", "result", "save"]),
      "[2a] ★段が QLV 用（ED/ES があり、中心線・エッジが無い）",
      Object.keys(rail),
    );
    check(!("centerline" in rail), "[2b] QCA の段が混ざっていない");
    // 🚨 未校正の理由が QCA と違う（EF は出せる、と伝える）。
    check(rail.calibration === "skipped", "[2c] 未校正の段は skipped", rail.calibration);
    const reason = (await viewer.getByTestId("xa-step-reason-calibration").textContent())?.trim() ?? "";
    check(
      /EF/.test(reason) && /(mL|容積)/.test(reason),
      "[2d] ★★未校正の理由が「EF は出せる／容積は出せない」になっている（QCA と別の文言）",
      reason,
    );

    // ── 条件 3: 輪郭を引く ─────────────────────────────────────────
    // 左室らしい位置（RAO 30° の 0009 では画像中央やや左下）。
    // ⚠️ **どちらを編集中かを明示してから引く**。編集対象は状態として残っているので、
    //    暗黙の既定に頼ると「ES に 2 回引いて ED が空のまま」になる（実際に踏んだ）。
    await viewer.getByTestId("qlv-edit-ed").click();
    await viewer.waitForTimeout(400);
    const edPts = ellipsePoints(235, 255, 78, 92, 11);
    await clickContour(viewer, st0, edPts);
    await viewer.waitForTimeout(800);
    const st1 = (await qlvState(viewer))!;
    check(st1.edPoints === edPts.length, "[3a] ★ED の輪郭点が順に入る（挿入位置が壊れていない）", {
      clicked: edPts.length,
      got: st1.edPoints,
    });
    const railEd = await railStates(viewer);
    check(railEd.edContour === "done", "[3b] ED の段が done になる", railEd.edContour);

    await viewer.getByTestId("qlv-edit-es").click();
    await viewer.waitForTimeout(500);
    const esPts = scaleAbout(edPts, SHRINK);
    await clickContour(viewer, st1, esPts);
    await viewer.waitForTimeout(1_000);
    const st2 = (await qlvState(viewer))!;
    check(st2.esPoints === esPts.length, "[3c] ES の輪郭点が入る", st2.esPoints);
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-contours.png") }).catch(() => {});

    // ── 条件 4: ★EF が理論値と一致する ────────────────────────────
    check(!!st2.result, "[4a] 両方の輪郭が揃うと結果が出る");
    if (!st2.result) throw new Error("結果が出ませんでした");
    const r = st2.result;
    check(
      Math.abs(r.ejectionFraction - EXPECTED_EF) < EF_TOL,
      `[4b] ★★EF が理論値 1 − k³ と一致する（k=${SHRINK} → ${EXPECTED_EF.toFixed(1)}%）`,
      { expected: Number(EXPECTED_EF.toFixed(2)), actual: Number(r.ejectionFraction.toFixed(2)) },
    );
    // 面積・長軸も k のべきで縮んでいる（EF だけ合っていて中身が違う、を排除する）。
    check(
      Math.abs(r.esAreaPx2 / r.edAreaPx2 - SHRINK ** 2) < 0.03,
      "[4c] 面積比が k²（Area-Length の中身が正しい）",
      { ratio: Number((r.esAreaPx2 / r.edAreaPx2).toFixed(4)), expected: SHRINK ** 2 },
    );
    check(
      Math.abs(r.esVolumePx3 / r.edVolumePx3 - SHRINK ** 3) < 0.04,
      "[4d] 容積比が k³",
      { ratio: Number((r.esVolumePx3 / r.edVolumePx3).toFixed(4)), expected: SHRINK ** 3 },
    );

    // ── 条件 5: 🚨 未校正では容積を出さない（EF は出す） ────────────
    check(r.unit === "px³", "[5a] ★未校正なので単位は px³（mL を騙らない）", r.unit);
    check(r.edvMl === null && r.esvMl === null, "[5b] ★容積 (mL) は出さない", {
      edv: r.edvMl,
      esv: r.esvMl,
    });
    check(r.kennedyEf === null, "[5c] ★★Kennedy 補正は出さない（アフィンなのでスケール不変でない）", r.kennedyEf);
    check(r.warnings.includes("uncalibrated"), "[5d] 未校正であることを警告に出す", r.warnings);
    const efShown = (await viewer.getByTestId("qlv-ef").textContent())?.trim() ?? "";
    check(/\d/.test(efShown), "[5e] 画面に EF が出る", efShown);
    const edvShown = (await viewer.getByTestId("qlv-edv").textContent())?.trim() ?? "";
    check(!/mL/.test(edvShown), "[5f] 画面の EDV は mL を出さない", edvShown);

    // ── 条件 6: 壁運動 ─────────────────────────────────────────────
    check(r.wallMotion?.length === 100, "[6a] 壁運動の弦が 100 本出る", r.wallMotion?.length);
    check(
      r.wallMotionMethod === "arc-length-chords",
      "[6b] ★Sheehan の centerline 法だと名乗らない（実装していない手法の名前を借りない）",
      r.wallMotionMethod,
    );
    // 一様に縮めたので全弦が内向き（正）。
    const negative = (r.wallMotion ?? []).filter((v) => v < 0).length;
    check(negative === 0, "[6c] 一様に縮めた輪郭では全弦が内向き（正）", { negative });
    const wmVisible = await viewer.getByTestId("qlv-wall-motion").isVisible().catch(() => false);
    check(wmVisible, "[6d] 壁運動のグラフが出る");

    // ── 条件 3b: 🚨 関心領域を切ると提案が変わる ───────────────────
    // 画面全体で造影画素を数えると、心室ではなく横隔膜・脊椎・カテーテル・大動脈を見てしまう。
    // 実データでは **ED/ES が 3 フレーム（≈120ms）しか離れていない**組が出た（心周期ではない）。
    const gapBefore = Math.abs(st2.esFrame - st2.edFrame);
    await viewer.getByTestId("qlv-resuggest-roi").click();
    await viewer.waitForTimeout(8_000);
    const stRoi = (await qlvState(viewer))!;
    const gapAfter = Math.abs(stRoi.esFrame - stRoi.edFrame);
    check(gapAfter !== gapBefore, "[6e] ★輪郭の範囲で数え直すと提案が変わる（心室を見るようになる）", {
      before: { ed: st2.edFrame, es: st2.esFrame, gap: gapBefore },
      after: { ed: stRoi.edFrame, es: stRoi.esFrame, gap: gapAfter },
    });
    // 生理的にありえない間隔なら**警告が出る**（黙って通さない）。
    const implausible = stRoi.frameWarnings.includes("implausibleInterval");
    const railRoi = await railStates(viewer);
    check(
      !implausible || railRoi.frames === "invalid",
      "[6f] ★★生理的にありえない ED/ES 間隔なら段を done にしない",
      { warnings: stRoi.frameWarnings, state: railRoi.frames },
    );
    // 輪郭は残る（フレームが変わったら消えるが、提案し直しただけでは消さない…はここでは
    // フレームが変われば消えるのが正しい。どちらでも結果の整合が取れていることを見る）。
    const stAfterRoi = (await qlvState(viewer))!;
    check(
      stAfterRoi.result === null || stAfterRoi.edPoints >= 4,
      "[6g] 結果と輪郭の状態が食い違わない",
      { points: stAfterRoi.edPoints, hasResult: !!stAfterRoi.result },
    );


    // ── 条件 7: 🚨 ED/ES をやり直すと両方の輪郭が消える ────────────
    // 輪郭は特定のフレームの上に引いてある。フレームを選び直したら別の心位相を指す。
    // まず輪郭を引き直しておく（消えるものが無いと、この検査は空振りで通る）。
    await viewer.getByTestId("qlv-edit-ed").click();
    await viewer.waitForTimeout(300);
    const stPre = (await qlvState(viewer))!;
    await clickContour(viewer, stPre, edPts);
    await viewer.getByTestId("qlv-edit-es").click();
    await viewer.waitForTimeout(300);
    await clickContour(viewer, stPre, esPts);
    await viewer.waitForTimeout(800);
    const stBeforeRedo = (await qlvState(viewer))!;
    check(
      stBeforeRedo.edPoints >= 4 && stBeforeRedo.esPoints >= 4,
      "[7-pre] やり直しの前に輪郭がある（空振りで通らないことを確かめる）",
      { ed: stBeforeRedo.edPoints, es: stBeforeRedo.esPoints },
    );
    await viewer.getByTestId("xa-step-redo-frames").click();
    await viewer.waitForTimeout(12_000);
    const st3 = (await qlvState(viewer))!;
    check(st3.edPoints === 0 && st3.esPoints === 0, "[7a] ★★両方の輪郭が捨てられる", {
      ed: st3.edPoints,
      es: st3.esPoints,
    });
    check(st3.result === null, "[7b] 結果も消える（古い数値が残らない）");

    // ── 条件 8: フレームを手で選ぶと「人が選択」になる ─────────────
    await viewer.getByTestId("qlv-ed-frame").fill("60");
    await viewer.waitForTimeout(1_000);
    const st4 = (await qlvState(viewer))!;
    check(st4.framesManual === true, "[8a] 人が選んだことが記録される");
    check(st4.edFrame === 60, "[8b] 指定したフレームになる", st4.edFrame);
    const railManual = await railStates(viewer);
    check(railManual.frames === "done", "[8c] 段が done になる", railManual.frames);
    const note = (await viewer.getByTestId("xa-step-note-frames").textContent())?.trim() ?? "";
    check(/人が選択|chosen/.test(note), "[8d] ★「自動提案のまま」ではなく「人が選択」と出る", note);

    // ── 条件 9: 保存（SR）─────────────────────────────────────────
    // 輪郭を引き直して結果を作る。
    await viewer.getByTestId("qlv-edit-ed").click();
    await viewer.waitForTimeout(400);
    const st5 = (await qlvState(viewer))!;
    await clickContour(viewer, st5, edPts);
    await viewer.waitForTimeout(600);
    await viewer.getByTestId("qlv-edit-es").click();
    await viewer.waitForTimeout(400);
    const st6 = (await qlvState(viewer))!;
    await clickContour(viewer, st6, esPts);
    await viewer.waitForTimeout(1_200);
    const st7 = (await qlvState(viewer))!;
    check(!!st7.result, "[9a] 引き直して結果が出る");
    await viewer.getByTestId("qlv-save-sr").click();
    await viewer.waitForTimeout(4_000);
    const after = await listSeries(driver.ports.http, studyUid);
    const sr = after.find(
      (s) => s.modality === "SR" && !seriesBefore.some((b) => b.seriesInstanceUid === s.seriesInstanceUid),
    );
    check(!!sr, "[9b] SR が保管庫に増える", sr?.seriesDescription);
    if (sr) {
      const sops = await instancesOf(driver.ports.http, studyUid, sr.seriesInstanceUid);
      const dump = sops.length ? await dumpTags(driver.ports.http, studyUid, sr.seriesInstanceUid, sops[0]) : "";
      fs.writeFileSync(path.join(OUT_DIR, "qlv-sr-tags.txt"), dump);
      check(/Ejection Fraction/.test(dump), "[9c] SR に EF が入る");
      check(
        !/End Diastolic Volume/.test(dump),
        "[9d] ★★未校正なので SR に容積を書いていない（px³ を mL と偽らない）",
      );
      check(
        /ED\/ES Frame Selection/.test(dump),
        "[9e] ED/ES の決め方が SR に残る（項目の存在も確かめる）",
      );
      check(/manual/.test(dump), "[9f] 人が選んだことが SR に残る");
      check(/NOT SPATIALLY CALIBRATED/.test(dump), "[9g] 未校正であることが SR 本文に残る");
      check(/scale invariant/.test(dump), "[9h] ★EF がなぜ有効なのかも残る");
    }
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-saved.png") }).catch(() => {});
  } finally {
    await driver.stop();
  }

  console.log(`\n===== QLV（左室造影・A5b）受け入れ条件 =====`);
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

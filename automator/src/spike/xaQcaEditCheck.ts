/*
 * QCA の中心線・エッジの**手修正**（A4 続き）の実機検証 — `fw/angio-design.md` §8.6。
 *
 * 実行:  cd automator && npx tsx src/spike/xaQcaEditCheck.ts
 *
 * ⚠️ ここでも**実データに真値は無い**。確かめるのは「手で直せること」と
 *    「直した事実が結果と保存物に正しく伝わること」まで。手修正で真値に戻ることは
 *    真値既知の合成ファントム（`frontend/src/viewer/qca.test.ts`）で数値検証してある。
 *
 * 🚨 この検証で一番危ないのは「操作したつもりで何も起きていない」パターン。
 *    canvas 上のドラッグは、掴めていなくてもエラーにならず、結果も変わらないので
 *    「変わらない＝正常」と読めてしまう。よって **まず操作が効いたことを数値で確かめ**、
 *    そのうえで期待する変化を見る。
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
import { dragOnCanvasHost } from "../common/pointerDrag.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-qca-edit");
const XA_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "xa-angio");
const SAMPLE = "0002.DCM";
const HOST = "viewer2d-canvas-host";

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
  centerline: [number, number][];
  edges: { left: [number, number]; right: [number, number] }[];
  pathIndices: number[];
  centerlineToken: string;
  provenance: { waypoints: number; editedEdges: number[]; trimmed: boolean; reference: string; edited: boolean };
  mld: number;
  rvd: number;
  percentDiameterStenosis: number;
  points: number;
  referenceFirst: number;
  referenceLast: number;
  unit: string;
  warnings: string[];
  view: { cx0: number; cy0: number; cw: number; ch: number; scale: number; dw: number; dh: number } | null;
}

/** 現在の QCA 状態（画像 px 座標と拡大パネルの変換つき）。 */
async function qcaState(page: Page): Promise<QcaState | null> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { __graphyDebug?: { getQcaState?: () => unknown } }).__graphyDebug;
    return (dbg?.getQcaState?.() ?? null) as unknown;
  }) as Promise<QcaState | null>;
}

/** 画像 px → 拡大パネル上のクライアント座標。 */
async function panelPoint(page: Page, st: QcaState, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("qca-editor-canvas").boundingBox();
  if (!box || !st.view) throw new Error("拡大パネルが見つかりません");
  // 表示は CSS で dw×dh 固定なので、box の実寸で割り戻して倍率のずれを吸収する。
  return {
    x: box.x + ((x - st.view.cx0) / st.view.cw) * box.width,
    y: box.y + ((y - st.view.cy0) / st.view.ch) * box.height,
  };
}

async function listSeries(httpPort: number, studyUid: string) {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/studies/${encodeURIComponent(studyUid)}/series`);
  return (await res.json()) as { seriesInstanceUid: string; modality: string | null; seriesDescription: string | null }[];
}

async function firstStudyUid(httpPort: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/studies`);
  const studies = (await res.json()) as { studyInstanceUid: string }[];
  if (!studies.length) throw new Error("スタディがありません");
  return studies[0].studyInstanceUid;
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

async function instancesOf(httpPort: number, studyUid: string, seriesUid: string): Promise<string[]> {
  const url =
    `http://127.0.0.1:${httpPort}/api/studies/${encodeURIComponent(studyUid)}` +
    `/series/${encodeURIComponent(seriesUid)}/instances`;
  const res = await fetch(url);
  const rows = (await res.json()) as { sopInstanceUid: string }[];
  return rows.map((r) => r.sopInstanceUid);
}


async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sample = path.join(XA_DIR, SAMPLE);
  if (!fs.existsSync(sample)) throw new Error(`XA サンプルがありません: ${sample}`);

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

    await viewer.getByTestId("cine-seek").fill("55");
    await viewer.waitForTimeout(1_500);

    // 解析区間を Length で指定する（既存 A4 と同じ導線）。
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.waitForTimeout(300);
    await viewer.getByText("長さ", { exact: true }).first().click();
    await viewer.waitForTimeout(400);
    await dragOnCanvasHost(viewer, HOST, 90, 60, 0, 12, { fracX: 0.42, fracY: 0.35 });
    await viewer.waitForTimeout(1_200);

    await viewer.getByTestId("xa-analysis-open").click();
    await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await viewer.getByTestId("xa-qca-run").click();
    await viewer.waitForTimeout(6_000);

    // ── 条件 1: 手修正パネルが出る ─────────────────────────────────
    const auto = await qcaState(viewer);
    check(!!auto && auto.points > 10, "[1a] 自動解析が結果を返す", { points: auto?.points, mld: auto?.mld });
    if (!auto) throw new Error("QCA の状態を取得できませんでした");
    const canvasVisible = await viewer.getByTestId("qca-editor-canvas").isVisible().catch(() => false);
    check(canvasVisible, "[1b] 解析区間の拡大パネルが出る");
    check(!!auto.view && auto.view.scale >= 1, "[1c] 拡大パネルの座標変換が取れる", auto.view);
    check(auto.provenance.edited === false, "[1d] 自動のままなら「手修正あり」ではない");
    const badge0 = await viewer.getByTestId("xa-qca-manual-badge").count();
    check(badge0 === 0, "[1e] 「手修正あり」の表示は出ていない", badge0);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-auto.png") }).catch(() => {});

    // ── 条件 2: 中間点で中心線を直せる ─────────────────────────────
    await viewer.getByTestId("xa-qca-mode-waypoint").click();
    await viewer.waitForTimeout(300);
    // 中心線の真ん中から法線方向に十分離れた位置へ置く（＝経路が確実に変わる位置）。
    const mid = auto.centerline[Math.floor(auto.centerline.length / 2)];
    const wpImage: [number, number] = [mid[0], mid[1] + 10];
    const wp = await panelPoint(viewer, auto, wpImage[0], wpImage[1]);
    await viewer.mouse.click(wp.x, wp.y);
    await viewer.waitForTimeout(2_500);
    const afterWp = await qcaState(viewer);
    check(afterWp?.provenance.waypoints === 1, "[2a] 中間点が 1 つ入る", afterWp?.provenance.waypoints);
    // ★「操作が効いた」ことを先に確かめる。中心線が変われば token が変わる。
    check(
      !!afterWp && afterWp.centerlineToken !== auto.centerlineToken,
      "[2b] ★中心線が実際に変わった（token が変わる）",
      { before: auto.centerlineToken, after: afterWp?.centerlineToken },
    );
    // 中心線が指定位置を通っている。
    const nearest = afterWp
      ? Math.min(...afterWp.centerline.map((c) => Math.hypot(c[0] - wpImage[0], c[1] - wpImage[1])))
      : Infinity;
    check(nearest < 2.0, "[2c] 中心線が指定した通過点を通る", Number(nearest.toFixed(2)));
    check(afterWp?.provenance.edited === true, "[2d] 「手修正あり」になる");
    const badge1 = await viewer.getByTestId("xa-qca-manual-badge").count();
    check(badge1 === 1, "[2e] 画面に「手修正あり」が出る", badge1);
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-waypoint.png") }).catch(() => {});

    // ── 条件 3: エッジを直せる ─────────────────────────────────────
    await viewer.getByTestId("xa-qca-mode-edge").click();
    await viewer.waitForTimeout(300);
    const st2 = (await qcaState(viewer))!;
    const ei = Math.floor(st2.edges.length / 2);
    const targetEdge = st2.edges[ei].right;
    const centerOfEdge = st2.centerline[ei];
    const from = await panelPoint(viewer, st2, targetEdge[0], targetEdge[1]);
    // 中心から外向きに 4px 分だけ引っ張る（法線方向は中心→エッジ）。
    const dirX = targetEdge[0] - centerOfEdge[0];
    const dirY = targetEdge[1] - centerOfEdge[1];
    const dl = Math.hypot(dirX, dirY) || 1;
    const to = await panelPoint(viewer, st2, targetEdge[0] + (dirX / dl) * 4, targetEdge[1] + (dirY / dl) * 4);
    await viewer.mouse.move(from.x, from.y);
    await viewer.mouse.down();
    await viewer.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await viewer.mouse.move(to.x, to.y, { steps: 4 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(2_000);
    const st3 = (await qcaState(viewer))!;
    // ★掴めていなければ何も起きない（＝「変わらない」で通ってしまう）ので、まず効いたことを見る。
    check(st3.provenance.editedEdges.length >= 1, "[3a] ★エッジを掴んで動かせた（手修正として記録される）", {
      edited: st3.provenance.editedEdges.length,
    });
    const movedTo = st3.edges[ei]?.right;
    const moveDist = movedTo ? Math.hypot(movedTo[0] - targetEdge[0], movedTo[1] - targetEdge[1]) : 0;
    check(moveDist > 1.5, "[3b] エッジ位置が実際に動いた [px]", Number(moveDist.toFixed(2)));
    // 法線上にしか動かない＝中心からの向きが変わらない。
    const cosBefore = (targetEdge[0] - centerOfEdge[0]) / dl;
    const cosAfter = movedTo ? (movedTo[0] - centerOfEdge[0]) / (Math.hypot(movedTo[0] - centerOfEdge[0], movedTo[1] - centerOfEdge[1]) || 1) : 0;
    check(Math.abs(cosAfter - cosBefore) < 0.05, "[3c] エッジは法線上にしか動かない（断面の意味を保つ）", {
      before: Number(cosBefore.toFixed(3)),
      after: Number(cosAfter.toFixed(3)),
    });
    check(st3.centerlineToken === st2.centerlineToken, "[3d] エッジ修正では中心線は変わらない");
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-edge.png") }).catch(() => {});

    // ── 条件 4: 中心線を変えたらエッジ修正は破棄される ─────────────
    // これが効いていないと「手で直したはずの点が違う場所に効く」という気づけない壊れ方をする。
    await viewer.getByTestId("xa-qca-mode-waypoint").click();
    await viewer.waitForTimeout(300);
    const st4 = (await qcaState(viewer))!;
    const q = st4.centerline[Math.floor(st4.centerline.length / 4)];
    const wp2 = await panelPoint(viewer, st4, q[0], q[1] - 8);
    await viewer.mouse.click(wp2.x, wp2.y);
    await viewer.waitForTimeout(2_500);
    const st5 = (await qcaState(viewer))!;
    check(st5.provenance.waypoints === 2, "[4a] 中間点が 2 つになる", st5.provenance.waypoints);
    check(st5.centerlineToken !== st4.centerlineToken, "[4b] ★中心線が変わった");
    check(
      st5.provenance.editedEdges.length === 0,
      "[4c] ★中心線が変わったのでエッジ修正は破棄されている（別の場所に当たらない）",
      st5.provenance.editedEdges.length,
    );

    // ── 条件 5: 区間の切り詰め ─────────────────────────────────────
    await viewer.getByTestId("xa-qca-chart-trim").click();
    await viewer.waitForTimeout(300);
    const chart = await viewer.getByTestId("xa-qca-chart").boundingBox();
    if (!chart) throw new Error("径プロファイルのグラフが見つかりません");
    const pointsBeforeTrim = st5.points;
    await viewer.mouse.move(chart.x + chart.width * 0.3, chart.y + chart.height * 0.5);
    await viewer.mouse.down();
    await viewer.mouse.move(chart.x + chart.width * 0.8, chart.y + chart.height * 0.5, { steps: 8 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(2_000);
    const st6 = (await qcaState(viewer))!;
    check(st6.provenance.trimmed === true, "[5a] ★区間を切り詰められた");
    check(st6.points < pointsBeforeTrim, "[5b] 計測点数が減る", { before: pointsBeforeTrim, after: st6.points });
    await viewer.getByTestId("xa-qca-clear-trim").click();
    await viewer.waitForTimeout(2_000);
    const st7 = (await qcaState(viewer))!;
    check(st7.provenance.trimmed === false && st7.points === pointsBeforeTrim, "[5c] 切り詰めを解除すると元に戻る", {
      points: st7.points,
    });

    // ── 条件 6: 健常部の指定で参照径が変わる ───────────────────────
    await viewer.getByTestId("xa-qca-chart-reference").click();
    await viewer.waitForTimeout(300);
    const rvdBefore = st7.rvd;
    await viewer.mouse.move(chart.x + chart.width * 0.05, chart.y + chart.height * 0.5);
    await viewer.mouse.down();
    await viewer.mouse.move(chart.x + chart.width * 0.25, chart.y + chart.height * 0.5, { steps: 8 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(2_000);
    const st8 = (await qcaState(viewer))!;
    check(st8.provenance.reference === "segments", "[6a] ★参照径が「健常部の指定」になる", st8.provenance.reference);
    check(Math.abs(st8.rvd - rvdBefore) > 1e-6, "[6b] 参照径の値が実際に変わる", {
      before: Number(rvdBefore.toFixed(3)),
      after: Number(st8.rvd.toFixed(3)),
    });
    // %DS が新しい RVD と整合している（表示だけ変えて計算を変えていない、を排除）。
    const expectedDs = (1 - st8.mld / st8.rvd) * 100;
    check(Math.abs(expectedDs - st8.percentDiameterStenosis) < 0.2, "[6c] %DS が新しい参照径と整合する", {
      shown: Number(st8.percentDiameterStenosis.toFixed(2)),
      computed: Number(expectedDs.toFixed(2)),
    });
    // ★区間 1 つなら参照径は定数（短い窓の傾きを区間外へ外挿しない）。
    check(
      Math.abs(st8.referenceFirst - st8.referenceLast) < 1e-9,
      "[6d] ★健常区間が 1 つなら参照径は定数（傾きを外挿しない）",
      { first: Number(st8.referenceFirst.toFixed(3)), last: Number(st8.referenceLast.toFixed(3)) },
    );
    // 2 つ目を遠位に足すと、その間を線形で結ぶ（テーパーを表現できる）。
    await viewer.mouse.move(chart.x + chart.width * 0.75, chart.y + chart.height * 0.5);
    await viewer.mouse.down();
    await viewer.mouse.move(chart.x + chart.width * 0.95, chart.y + chart.height * 0.5, { steps: 8 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(2_000);
    const st8b = (await qcaState(viewer))!;
    check(
      Math.abs(st8b.referenceFirst - st8b.referenceLast) > 1e-6,
      "[6e] 健常区間が 2 つなら参照径は傾きを持つ（テーパーを表現できる）",
      { first: Number(st8b.referenceFirst.toFixed(3)), last: Number(st8b.referenceLast.toFixed(3)) },
    );
    await viewer.screenshot({ path: path.join(OUT_DIR, "4-reference.png") }).catch(() => {});

    // ── 条件 7: 保存した SR に手修正が記録される ───────────────────
    await viewer.getByRole("button", { name: /計測値を保存|Save measurements/ }).click();
    await viewer.waitForTimeout(3_000);
    const afterSave = await listSeries(driver.ports.http, studyUid);
    const sr = afterSave.find(
      (s) => s.modality === "SR" && !seriesBefore.some((b) => b.seriesInstanceUid === s.seriesInstanceUid),
    );
    check(!!sr, "[7a] SR が保管庫に増える", sr?.seriesDescription);
    if (sr) {
      const sops = await instancesOf(driver.ports.http, studyUid, sr.seriesInstanceUid);
      const dump = sops.length ? await dumpTags(driver.ports.http, studyUid, sr.seriesInstanceUid, sops[0]) : "";
      fs.writeFileSync(path.join(OUT_DIR, "qca-sr-edited-tags.txt"), dump);
      check(/Manual Correction/.test(dump), "[7b] ★SR に「手修正」の概念が入っている");
      check(/waypoints=2/.test(dump), "[7c] 中間点の数まで残っている", /waypoints=\d+/.exec(dump)?.[0]);
      check(/reference=segments/.test(dump), "[7d] 参照径の決め方が残っている");
      // ⚠️ 「"None" が無いこと」だけを見ると、項目そのものが無いときにも通ってしまう
      //    （実際にこの検証を書いた初回、古い jar に繋がって [7b]〜[7d] が落ちる中で
      //     ここだけ**空振りで合格**した）。項目があることと中身の両方を見る。
      check(
        /Manual Correction/.test(dump) && !/None \(fully automatic\)/.test(dump),
        "[7e] 手修正したものを「全自動」と書いていない（項目の存在も確かめる）",
      );
    }

    // ── 条件 8: 手修正を全部破棄すると自動の結果に戻る ─────────────
    await viewer.getByTestId("xa-qca-reset").click();
    await viewer.waitForTimeout(4_000);
    const st9 = (await qcaState(viewer))!;
    check(st9.provenance.edited === false, "[8a] 手修正が全部消える");
    check(st9.centerlineToken === auto.centerlineToken, "[8b] ★最初の自動解析と同じ中心線に戻る", {
      first: auto.centerlineToken,
      now: st9.centerlineToken,
    });
    check(Math.abs(st9.mld - auto.mld) < 1e-6 && Math.abs(st9.rvd - auto.rvd) < 1e-6, "[8c] 数値も自動時と一致する", {
      mld: st9.mld,
      rvd: st9.rvd,
    });
    await viewer.screenshot({ path: path.join(OUT_DIR, "5-reset.png") }).catch(() => {});

    // ── 条件 9: 全自動で保存すると「手修正なし」と書かれる ─────────
    await viewer.getByRole("button", { name: /計測値を保存|Save measurements/ }).click();
    await viewer.waitForTimeout(3_000);
    const afterSave2 = await listSeries(driver.ports.http, studyUid);
    const srs = afterSave2.filter(
      (s) => s.modality === "SR" && !seriesBefore.some((b) => b.seriesInstanceUid === s.seriesInstanceUid),
    );
    const sr2 = srs.find((s) => s.seriesInstanceUid !== sr?.seriesInstanceUid);
    if (sr2) {
      const sops = await instancesOf(driver.ports.http, studyUid, sr2.seriesInstanceUid);
      const dump = sops.length ? await dumpTags(driver.ports.http, studyUid, sr2.seriesInstanceUid, sops[0]) : "";
      check(
        /None \(fully automatic\)/.test(dump),
        "[9] ★全自動の結果は「手修正なし」と明示される（項目が無い＝全自動、と読ませない）",
      );
    } else {
      check(false, "[9] 2 本目の SR を保存できた");
    }
  } finally {
    await driver.stop();
  }

  console.log(`\n===== QCA 手修正（§8.6）受け入れ条件 =====`);
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

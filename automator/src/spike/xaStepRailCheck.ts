/*
 * 解析タスクのステップ・レール（A13-1）の実機検証 — `fw/angio-design.md` §21.2 / §21.6。
 *
 * 実行:  cd automator && npx tsx src/spike/xaStepRailCheck.ts
 *
 * <h3>何を確かめるか</h3>
 * レールは「見た目の飾り」ではなく **状態の主張**なので、主張と実体が一致することを見る:
 * 1. **飛ばした段が「済」に見えない**（未校正のまま出た px の数値が承認済みに見えないこと）
 * 2. **自動のままの段が「人が確かめた」と見えない**
 * 3. **「この段からやり直す」が、上流の手修正を巻き込まない**
 *    ← 最初の実装は `invalidates` を辿って `clears` を集めており、**校正をやり直すだけで
 *      手修正が全部消える**状態だった（vitest で捕まえたが、実機でも押さえておく）
 *
 * ⚠️ **`data-state` 属性で判定する。色や記号で判定しない**（見た目を変えたら壊れるテストにしない）。
 * ⚠️ automator を回す前に `cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-step-rail");
const XA_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "xa-angio");
const SAMPLE = "0002.DCM";
const HOST = "viewer2d-canvas-host";
/** 段の並び（`frontend/src/viewer/xaTasks.ts` の `QCA_STEPS` と一致していること）。 */
const ORDER = ["input", "calibration", "analysis", "centerline", "edges", "range", "save"];

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
  centerlineToken: string;
  provenance: { waypoints: number; editedEdges: number[]; trimmed: boolean; reference: string; edited: boolean };
  mld: number;
  rvd: number;
  points: number;
  unit: string;
  view: { cx0: number; cy0: number; cw: number; ch: number; scale: number; dw: number; dh: number } | null;
}

async function qcaState(page: Page): Promise<QcaState | null> {
  return page.evaluate(`(() => {
    const dbg = window.__graphyDebug;
    return (dbg && dbg.getQcaState ? dbg.getQcaState() : null);
  })()`) as Promise<QcaState | null>;
}

/** レール上の各段の状態（`data-state`）。**色ではなくこれで判定する**。 */
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

/** 段に添えられた注記の文言（自動のまま / 手修正 N 点）。 */
async function noteOf(page: Page, id: string): Promise<string> {
  const n = page.getByTestId(`xa-step-note-${id}`);
  return (await n.count()) > 0 ? ((await n.first().textContent()) ?? "").trim() : "";
}

async function panelPoint(page: Page, st: QcaState, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId("qca-editor-canvas").boundingBox();
  if (!box || !st.view) throw new Error("拡大パネルが見つかりません");
  return {
    x: box.x + ((x - st.view.cx0) / st.view.cw) * box.width,
    y: box.y + ((y - st.view.cy0) / st.view.ch) * box.height,
  };
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
  if (!fs.existsSync(sample)) throw new Error(`XA サンプルがありません: ${sample}`);

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [sample]);
    if (imp.imported !== 1) throw new Error(`取込に失敗: ${JSON.stringify(imp)}`);
    const studyUid = await firstStudyUid(driver.ports.http);

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
    await viewer.getByTestId("cine-seek").fill("55");
    await viewer.waitForTimeout(1_500);

    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.waitForTimeout(300);
    await viewer.getByText("長さ", { exact: true }).first().click();
    await viewer.waitForTimeout(400);
    await dragOnCanvasHost(viewer, HOST, 90, 60, 0, 12, { fracX: 0.42, fracY: 0.35 });
    await viewer.waitForTimeout(1_200);

    await viewer.getByTestId("xa-analysis-open").click();
    await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });

    // ── 条件 1: レールが出て、段が定義どおり並ぶ ───────────────────
    const railVisible = await viewer.getByTestId("xa-step-rail").isVisible().catch(() => false);
    check(railVisible, "[1a] ステップ・レールが出る");
    const s0 = await railStates(viewer);
    check(
      JSON.stringify(Object.keys(s0)) === JSON.stringify(ORDER),
      "[1b] 段が定義どおりの順で並ぶ",
      Object.keys(s0),
    );
    check(s0.input === "done", "[1c] 長さ計測を引いてあるので「入力」は済", s0.input);

    // ── 条件 2: 🚨 未校正は「済」ではなく「飛ばした」 ───────────────
    // ここが「済」に見えると、px で出た数値が承認済みに見える。
    check(s0.calibration === "skipped", "[2a] ★未校正の段は skipped（done ではない）", s0.calibration);
    const reason = await viewer.getByTestId("xa-step-reason-calibration").textContent();
    check(!!reason && /px/.test(reason), "[2b] 飛ばした理由が出る", reason?.trim());
    check(s0.analysis === "active", "[2c] 飛ばした段は active にならず、次の段が active になる", s0.analysis);
    const activeCount0 = Object.values(s0).filter((v) => v === "active").length;
    check(activeCount0 === 1, "[2d] active は 1 つだけ", activeCount0);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-uncalibrated.png") }).catch(() => {});

    // ── 条件 3: 校正すると「済」になり、出自が注記に出る ────────────
    await viewer.getByTestId("xa-catheter-fr").fill("6");
    await viewer.getByTestId("xa-calibrate-catheter").click();
    await viewer.waitForTimeout(1_500);
    const s1 = await railStates(viewer);
    check(s1.calibration === "done", "[3a] 校正すると done になる", s1.calibration);
    const calNote = await noteOf(viewer, "calibration");
    check(/カテーテル|catheter/i.test(calNote), "[3b] 校正の出自が注記に出る", calNote);

    // ── 条件 4: 解析すると後続の段が「自動のまま」と名乗る ──────────
    await viewer.getByTestId("xa-qca-run").click();
    await viewer.waitForTimeout(6_000);
    const auto = await qcaState(viewer);
    check(!!auto && auto.points > 10, "[4a] 解析が結果を返す", { points: auto?.points, unit: auto?.unit });
    if (!auto) throw new Error("QCA の状態を取得できませんでした");
    const s2 = await railStates(viewer);
    check(s2.analysis === "done", "[4b] 「QCA を実行」が done", s2.analysis);
    const autoNote = await noteOf(viewer, "centerline");
    check(
      /自動|automatic/i.test(autoNote),
      "[4c] ★自動のままの段は「自動（未確認）」と名乗る（人が確かめた値と混ざらない）",
      autoNote,
    );
    check(/自動|automatic/i.test(await noteOf(viewer, "edges")), "[4d] エッジも同様");
    check(/自動|automatic/i.test(await noteOf(viewer, "range")), "[4e] 区間・参照径も同様");
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-auto.png") }).catch(() => {});

    // ── 条件 5: 手で直すと注記が変わる ─────────────────────────────
    await viewer.getByTestId("xa-qca-mode-waypoint").click();
    await viewer.waitForTimeout(300);
    const mid = auto.centerline[Math.floor(auto.centerline.length / 2)];
    const wp = await panelPoint(viewer, auto, mid[0], mid[1] + 10);
    await viewer.mouse.click(wp.x, wp.y);
    await viewer.waitForTimeout(2_500);
    const afterWp = (await qcaState(viewer))!;
    check(afterWp.provenance.waypoints === 1, "[5a] ★通過点が実際に入った", afterWp.provenance.waypoints);
    const wpNote = await noteOf(viewer, "centerline");
    check(/1/.test(wpNote) && !/自動|automatic/i.test(wpNote), "[5b] 中心線の段が「手修正 1 点」になる", wpNote);

    // ── 条件 6: 参照径も手で指定する（次の条件の準備） ──────────────
    await viewer.getByTestId("xa-qca-chart-reference").click();
    await viewer.waitForTimeout(300);
    const chart = await viewer.getByTestId("xa-qca-chart").boundingBox();
    if (!chart) throw new Error("径プロファイルのグラフが見つかりません");
    await viewer.mouse.move(chart.x + chart.width * 0.05, chart.y + chart.height * 0.5);
    await viewer.mouse.down();
    await viewer.mouse.move(chart.x + chart.width * 0.25, chart.y + chart.height * 0.5, { steps: 8 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(2_000);
    const withRef = (await qcaState(viewer))!;
    check(withRef.provenance.reference === "segments", "[6a] ★参照径を手で指定できた", withRef.provenance.reference);
    check(withRef.provenance.waypoints === 1, "[6b] 通過点はそのまま残っている", withRef.provenance.waypoints);

    // ── 条件 7: 🚨「この段からやり直す」が上流を巻き込まない ─────────
    // 参照径の段をやり直す ⇒ 参照径は自動に戻るが、**通過点は残る**。
    // ここが壊れると「関係ない操作が巻き戻った」というだけでなく、
    // 直したはずの中心線が黙って自動に戻った結果で数値が出る。
    await viewer.getByTestId("xa-step-redo-range").click();
    await viewer.waitForTimeout(3_000);
    const afterRedoRange = (await qcaState(viewer))!;
    check(
      afterRedoRange.provenance.reference === "auto",
      "[7a] ★参照径が自動に戻る",
      afterRedoRange.provenance.reference,
    );
    check(
      afterRedoRange.provenance.waypoints === 1,
      "[7b] ★★上流（中心線の通過点）は巻き込まれない",
      afterRedoRange.provenance.waypoints,
    );
    check(
      afterRedoRange.centerlineToken === withRef.centerlineToken,
      "[7c] 中心線そのものも変わっていない",
      { before: withRef.centerlineToken, after: afterRedoRange.centerlineToken },
    );

    // ── 条件 8: 中心線の段をやり直すと、通過点が消えて自動に戻る ─────
    await viewer.getByTestId("xa-step-redo-centerline").click();
    await viewer.waitForTimeout(3_000);
    const afterRedoCl = (await qcaState(viewer))!;
    check(afterRedoCl.provenance.waypoints === 0, "[8a] ★通過点が消える", afterRedoCl.provenance.waypoints);
    check(
      afterRedoCl.centerlineToken === auto.centerlineToken,
      "[8b] ★最初の自動解析と同じ中心線に戻る",
      { first: auto.centerlineToken, now: afterRedoCl.centerlineToken },
    );
    check(
      Math.abs(afterRedoCl.mld - auto.mld) < 1e-6 && Math.abs(afterRedoCl.rvd - auto.rvd) < 1e-6,
      "[8c] 数値も自動時と一致する（表示だけ戻して計算が残っていない）",
      { mld: afterRedoCl.mld, rvd: afterRedoCl.rvd },
    );
    const backToAuto = await noteOf(viewer, "centerline");
    check(/自動|automatic/i.test(backToAuto), "[8d] 注記が「自動」に戻る", backToAuto);

    // ── 条件 9: 「やり直す」ボタンは、やり直せる段にしか出ない ───────
    const redoCalib = await viewer.getByTestId("xa-step-redo-calibration").count();
    check(redoCalib === 0, "[9a] 校正の段には「やり直す」が出ない（捨てる手修正が無いため）", redoCalib);
    const redoInput = await viewer.getByTestId("xa-step-redo-input").count();
    check(redoInput === 0, "[9b] 入力の段にも出ない", redoInput);
    const redoCl = await viewer.getByTestId("xa-step-redo-centerline").count();
    check(redoCl === 1, "[9c] 中心線の段には出る", redoCl);

    // ── 条件 10: 段を押すとその節へ移動する ────────────────────────
    await viewer.getByTestId("xa-step-save").getByRole("button").first().click();
    await viewer.waitForTimeout(1_200);
    const saveVisible = await viewer.evaluate(`(() => {
      const el = document.querySelector('[data-step~="save"]');
      const box = el && el.getBoundingClientRect();
      if (!box) return null;
      return { top: box.top, bottom: box.bottom, vh: window.innerHeight };
    })()`) as { top: number; bottom: number; vh: number } | null;
    check(
      !!saveVisible && saveVisible.top < saveVisible.vh && saveVisible.bottom > 0,
      "[10] 段を押すと対応する節が見える位置に来る",
      saveVisible,
    );

    // ── 条件 11: 凡例が「飛ばした ≠ 済」と明記している ──────────────
    const legend = await viewer.getByTestId("xa-step-rail").textContent();
    check(
      !!legend && /飛ばした|skipped/i.test(legend),
      "[11] 凡例に「飛ばした」が「済」ではないと書いてある",
    );
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-final.png") }).catch(() => {});
  } finally {
    await driver.stop();
  }

  console.log(`\n===== 解析タスクのステップ・レール（§21.6 / A13-1）=====`);
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

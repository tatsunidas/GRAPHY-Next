/*
 * MCP の 2D ビューアの表示操作（set_window_level・go_to_slice など 10 種と undo_viewer_action）の実機検証（段 4c-1。
 * roadmap fw/mcp-server-design.md §6）。実際の中継（desktop/mcpCli.js、stdio）から操作し、**画面**（W/L の表示・スクリーンショット）と
 * get_viewer_state を突き合わせる。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=19540 GRAPHY_AUTOMATOR_SCP_PORT=19541 GRAPHY_AUTOMATOR_VITE_PORT=19543 \
 *          npx tsx src/spike/mcpViewerControlCheck.ts [検査のフォルダ（既定 ~/graphy-demo-samples/HASSAKU_DCM。複数スライスのシリーズを含むこと）]
 *
 *   1. 既定（allowViewerControl オフ）: 制御ツールが一覧に出ない／呼ぶと control-disabled。
 *   2. オン: 窓位・窓幅（画面の W/L の表示と一致）・スライス・回転・左右反転・白黒反転・レイアウト・ツール。画面と状態が一致。
 *   3. 負例: 範囲外・未知のプリセット・未知のツール名・write の操作は、画面を変えず符号で返る。
 *   4. undo を繰り返すと、操作前の状態に戻る。空なら nothing-to-undo。別の接続は履歴が別。
 *   5. 連打で rate-limited。2D 窓を閉じると no-viewer（履歴も消える）。
 *   6. 患者の値が、結果・監査ログ・中継の stderr に 0 件。
 *
 * 一時の userData（--user-data-dir）に mcp.json を置いて起動する（開発者の ~/.config を使わない）。同意ダイアログは dialog のスタブで許可する。
 * 前提: backend jar（今のビルド）・frontend の依存・desktop の electron・desktop/mcp/run.cjs（npm run build:mcp）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { McpStdio } from "./mcpStdioClient.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "mcp-viewer-control");
const SAMPLE = process.argv[2] ?? path.join(os.homedir(), "graphy-demo-samples", "HASSAKU_DCM");

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

interface Tile { tile: string; sliceIndex: number; sliceCount: number; windowCenter: number; windowWidth: number; rotation: number; flipH: boolean; flipV: boolean; invert: boolean; zoom: number }
interface State { tiles: Tile[]; activeTool: string; layoutCols: number }

async function state(mcp: McpStdio): Promise<State> {
  const r = await mcp.call("get_viewer_state");
  if (r.isError) throw new Error(`get_viewer_state: ${r.text}`);
  return r.json as State;
}

/** 画面（2D ビューアの窓）に表示されている W/L。 */
async function screenWl(page: Page): Promise<{ c: number; w: number } | null> {
  const t = await page.locator("body").innerText();
  const m = /W\/L\s*(-?[\d.]+)\s*\/\s*(-?[\d.]+)/.exec(t);
  return m ? { c: Number(m[1]), w: Number(m[2]) } : null;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userData = path.join(OUT_DIR, "userdata");
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  const prefs = (control: boolean) => fs.writeFileSync(path.join(userData, "mcp.json"), JSON.stringify({ enabled: true, includePhi: false, allowAnalysis: false, allowViewerControl: control }));
  prefs(false);

  const d = new DesktopDriver({}, { extraElectronArgs: [`--user-data-dir=${userData}`] });
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  let mcp: McpStdio | null = null;
  let other: McpStdio | null = null;
  try {
    await resetDb(d.ports.http);
    await importPaths(d.ports.http, [SAMPLE]);
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { patientName?: string; patientId?: string; studyInstanceUid: string }[];
    const truth = [studies[0]?.patientName, studies[0]?.patientId, studies[0]?.studyInstanceUid].filter((v): v is string => typeof v === "string" && v.trim().length >= 3);

    const mainPage = d.page;
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await mainPage.waitForTimeout(2000);
    const later = mainPage.getByRole("button", { name: /^(後で|Later)$/ });
    if (await later.isVisible().catch(() => false)) {
      await later.click();
      await mainPage.waitForTimeout(500);
    }
    await mainPage.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await openFirstSeriesInViewer(mainPage, createStepRecorder());
    const viewer = await d.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2500);

    const endpoint = path.join(userData, "mcp-endpoint.json");
    for (let i = 0; i < 50 && !fs.existsSync(endpoint); i++) await new Promise((r) => setTimeout(r, 200));
    check(fs.existsSync(endpoint), "受け口が待ち受けている");
    await d.app.evaluate(({ dialog }) => {
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    mcp = McpStdio.fromRepo(endpoint, "claude-control-check");
    await mcp.init();
    const toolNames = async (m: McpStdio) => (((await m.request("tools/list")).result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name);
    const CONTROL = ["set_window_level", "reset_window", "apply_window_preset", "rotate_view", "flip_horizontal", "flip_vertical", "invert_colors", "go_to_slice", "set_layout", "set_tool", "undo_viewer_action"];

    console.log("\n[1] 既定（表示操作の許可がオフ）");
    const off = await toolNames(mcp);
    check(CONTROL.every((n) => !off.includes(n)) && off.includes("get_viewer_state"), "制御ツールが一覧に出ない（読み取りは出る）", off.filter((n) => CONTROL.includes(n)));
    const s0off = await state(mcp);
    const denied = await mcp.call("set_window_level", { center: 600, width: 1200 });
    check(denied.isError && /control-disabled/.test(denied.text), "オフで呼ぶと control-disabled", denied.text);
    check(JSON.stringify(await state(mcp)) === JSON.stringify(s0off), "オフでは画面（状態）が変わらない");

    console.log("\n[2] 表示操作をオン: 画面と状態の一致");
    prefs(true);
    const on = await toolNames(mcp);
    check(CONTROL.every((n) => on.includes(n)), "オンで制御ツール 11 個が出る", CONTROL.filter((n) => !on.includes(n)));
    const S0 = await state(mcp);
    const t0 = S0.tiles[0];
    console.log(`  初期: slice ${t0.sliceIndex}/${t0.sliceCount} W/L ${t0.windowCenter}/${t0.windowWidth} cols ${S0.layoutCols} tool ${S0.activeTool}`);
    // 画像（キャンバス）の画素で比べる。ツールバー（レイアウトの選択・ビューア自身の「元に戻す」ボタンなど）は別に見る
    const shot = async (n: string) => {
      const f = path.join(OUT_DIR, `${n}.png`);
      await viewer.getByTestId("series-viewer-root").first().locator("canvas").first().screenshot({ path: f });
      await viewer.screenshot({ path: path.join(OUT_DIR, `${n}-window.png`) });
      return fs.readFileSync(f);
    };
    const selects = () => viewer.$$eval("select", (els) => els.map((e) => (e as HTMLSelectElement).value));
    const selectsBefore = await selects();
    const before = await shot("00-initial");
    const screen0 = await screenWl(viewer);
    check(!!screen0 && Math.abs(screen0.c - t0.windowCenter) < 1 && Math.abs(screen0.w - t0.windowWidth) < 1, "操作前: 画面の W/L の表示が get_viewer_state と一致", { screen: screen0, state: [t0.windowCenter, t0.windowWidth] });
    let applied = 0;
    const ok = async (tool: string, args: Record<string, unknown>) => {
      const r = await mcp!.call(tool, args);
      check(!r.isError, `${tool}(${JSON.stringify(args)}) が通る`, r.text);
      if (!r.isError) applied++;
      await viewer.waitForTimeout(500);
      return r;
    };

    const wl = { center: Math.round(t0.windowCenter * 0.5) + 7, width: Math.round(t0.windowWidth * 0.5) + 11 };
    await ok("set_window_level", wl);
    const s1 = await state(mcp);
    check(s1.tiles[0].windowCenter === wl.center && s1.tiles[0].windowWidth === wl.width, "set_window_level: 状態が指定の W/L", { state: [s1.tiles[0].windowCenter, s1.tiles[0].windowWidth], want: wl });
    const sc1 = await screenWl(viewer);
    check(!!sc1 && Math.abs(sc1.c - wl.center) < 1 && Math.abs(sc1.w - wl.width) < 1, "set_window_level: 画面の W/L の表示が指定どおりに変わった", { screen: sc1, want: wl });
    await shot("01-window-level");

    const want = Math.min(8, t0.sliceCount - 1);
    await ok("go_to_slice", { index: want });
    const s2 = await state(mcp);
    check(s2.tiles[0].sliceIndex === want, `go_to_slice: スライス ${want} へ移動した`, s2.tiles[0].sliceIndex);
    const sliceShot = await shot("02-slice");
    check(!sliceShot.equals(before), "go_to_slice: 画面（スクリーンショット）が変わった");

    await ok("rotate_view", { times: 1 });
    check(((await state(mcp)).tiles[0].rotation % 360) === 90, "rotate_view: 回転 90 度");
    await shot("03-rotate");
    await ok("flip_horizontal", {});
    check((await state(mcp)).tiles[0].flipH === true, "flip_horizontal: 左右反転");
    await ok("invert_colors", {});
    check((await state(mcp)).tiles[0].invert === true, "invert_colors: 白黒反転");
    await shot("04-flip-invert");
    await ok("set_layout", { cols: 2 });
    check((await state(mcp)).layoutCols === 2, "set_layout: 列数 2");
    await viewer.waitForTimeout(800);
    await shot("05-layout");
    await ok("set_tool", { tool: "zoom" });
    const sTool = await state(mcp);
    check(/zoom/i.test(sTool.activeTool), "set_tool: ズームのツール", sTool.activeTool);
    const SAFTER = await state(mcp);

    console.log("\n[3] 負例: 画面を変えない");
    const neg: [string, Record<string, unknown>, RegExp][] = [
      ["set_window_level", { center: 1e9, width: 400 }, /bad-arg:center/],
      ["set_window_level", { center: 40, width: 0 }, /bad-arg:width/],
      ["set_layout", { cols: 99 }, /bad-arg:cols/],
      ["set_tool", { tool: "ruler" }, /bad-arg:tool/],
      ["apply_window_preset", { name: "no-such-preset-xyz" }, /unknown-preset/],
      ["go_to_slice", { index: -1 }, /bad-arg:index/],
      ["create_roi", {}, /unknown-tool/],
      ["clear_measurements", {}, /unknown-tool/],
      ["flip_vertical", { id: "createRoi" }, /unknown-arg:id/],
    ];
    for (const [tool, args, re] of neg) {
      const r = await mcp.call(tool, args);
      check(r.isError && re.test(r.text), `${tool}(${JSON.stringify(args)}) は ${re.source}`, r.text);
    }
    check(JSON.stringify(await state(mcp)) === JSON.stringify(SAFTER), "負例のあと、画面（状態）は変わっていない");

    console.log("\n[4] undo と履歴");
    other = McpStdio.fromRepo(endpoint, "claude-other-client");
    await other.init();
    const otherUndo = await other.call("undo_viewer_action");
    check(otherUndo.isError && /nothing-to-undo/.test(otherUndo.text), "別の接続は履歴が別（他の接続の操作は戻せない）", otherUndo.text);
    // 有効だった操作の数だけ戻せる（回転・左右反転・白黒反転・レイアウト・ツール・スライス・窓）。1 つの操作が複数の逆操作を持つ場合も 1 回で戻る
    let undone = 0;
    for (let i = 0; i < applied + 3; i++) {
      const r = await mcp.call("undo_viewer_action");
      if (r.isError) {
        check(/nothing-to-undo/.test(r.text), "履歴が尽きたら nothing-to-undo", r.text);
        break;
      }
      undone++;
      await viewer.waitForTimeout(400);
    }
    check(undone === applied, "有効だった操作と同じ回数だけ戻せる", { applied, undone });
    const S1 = await state(mcp);
    check(JSON.stringify(S1) === JSON.stringify(S0), "undo を繰り返すと、操作前の状態に戻る（get_viewer_state が一致）", { before: S0.tiles[0], after: S1.tiles[0], cols: [S0.layoutCols, S1.layoutCols], tool: [S0.activeTool, S1.activeTool] });
    const screen1 = await screenWl(viewer);
    check(!!screen1 && screen0 !== null && Math.abs(screen1.c - screen0.c) < 1 && Math.abs(screen1.w - screen0.w) < 1, "undo 後の画面の W/L が操作前と同じ", { screen0, screen1 });
    const after = await shot("06-undone");
    check(after.equals(before), "undo 後の画像の領域（スクリーンショット）が操作前と同じ");
    // 記録（失敗にしない）: ツールバーの選択（レイアウトの「自動」など）が操作前と同じか。set_layout の逆操作は列数を固定で戻す（アシスタントの「元に戻す」と同じ）
    const selectsAfter = await selects();
    console.log(`  [情報] ツールバーの選択（操作前 → undo 後）: ${JSON.stringify(selectsBefore)} → ${JSON.stringify(selectsAfter)}${JSON.stringify(selectsBefore) === JSON.stringify(selectsAfter) ? "（同じ）" : "（違う。レイアウトの自動 → 固定の列数など）"}。ビューア自身の「元に戻す」ボタン（↶）は、MCP の操作のあと有効になる（06-undone-window.png を参照）`);

    console.log("\n[5] 連打の上限と、2D 窓を閉じたとき");
    await viewer.waitForTimeout(11_000); // 直前の操作が窓（10 秒）から出るのを待つ
    let limited = 0;
    let passedN = 0;
    for (let i = 0; i < 25; i++) {
      const r = await mcp.call("flip_horizontal");
      if (r.isError && /rate-limited/.test(r.text)) limited++;
      else if (!r.isError) passedN++;
    }
    check(passedN === 20 && limited === 5, "連打は 20 回まで通り、超えると rate-limited", { passedN, limited });
    await viewer.waitForTimeout(11_000);
    await viewer.close();
    await new Promise((r) => setTimeout(r, 1500));
    const gone = await mcp.call("set_layout", { cols: 1 });
    check(gone.isError && /no-viewer/.test(gone.text), "2D 窓を閉じると no-viewer", gone.text);
    const goneUndo = await mcp.call("undo_viewer_action");
    check(goneUndo.isError && /nothing-to-undo/.test(goneUndo.text), "窓が閉じたら履歴も消える", goneUndo.text);

    console.log("\n[6] 患者情報");
    const audit = fs.readFileSync(path.join(userData, "mcp-audit.jsonl"), "utf8");
    check(truth.length > 0 && truth.every((v) => !audit.includes(v)), "監査ログに患者の値が 0 件", { truthKinds: truth.length });
    check(truth.every((v) => !mcp!.stderr.includes(v) && !other!.stderr.includes(v)), "中継の stderr に患者の値が 0 件");
    check(/set_window_level/.test(audit) && /undo_viewer_action/.test(audit), "監査ログに表示操作の呼び出し（ツール名）が残る");
    const journal = path.join(userData, "assistant-journal.jsonl");
    check(fs.existsSync(journal) && /mcp:claude-control-check/.test(fs.readFileSync(journal, "utf8")), "操作の記録（assistant-journal）に mcp:<クライアント名> で残る");
  } finally {
    mcp?.close();
    other?.close();
    await d.stop();
  }
  console.log(`\n=== ${passed} 件合格 / ${failures.length} 件失敗 ===`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

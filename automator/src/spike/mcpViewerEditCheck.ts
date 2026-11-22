/*
 * MCP の ROI の作成・計測の全削除（create_roi・create_contour_roi・clear_measurements。allowViewerEdit）の実機検証（段 4c-2a。
 * roadmap fw/mcp-server-design.md §6）。実際の中継（desktop/mcpCli.js、stdio）から操作し、**画面**（ROI の面積・スクリーンショット）と
 * get_measurements を突き合わせる。確認ダイアログは dialog.showMessageBox のスタブ（回数・文面・同時に開いた数を記録）と、
 * 最後だけ**本物のダイアログ**（答えないと 120 秒で自動的に取り消される）で確かめる。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=19540 GRAPHY_AUTOMATOR_SCP_PORT=19541 GRAPHY_AUTOMATOR_VITE_PORT=19543 \
 *          npx tsx src/spike/mcpViewerEditCheck.ts [検査のフォルダ（既定 ~/graphy-demo-samples/HASSAKU_DCM）]
 *
 *   1. 既定（allowViewerEdit オフ）: ツールが出ない／呼ぶと edit-disabled。
 *   2. create_roi（楕円 rx=20 mm・ry=10 mm）→ 確認が 1 回（文面にクライアント名・形）→ 面積 ≈ π·20·10 mm²。拒否 → declined で増えない。
 *   3. create_contour_roi: 多角形は作られる／自己交差・面積ゼロ・点が少ない・範囲外は確認を出さずに符号で返る。
 *   4. undo_viewer_action は、この接続が作った ROI だけ消す（手で描いた計測は残る）。
 *   5. clear_measurements: 拒否 → 残る／承認 → 0 件。元に戻せない。文面に「元に戻せません」。
 *   6. 3 つの create_roi を同時に呼んでも、確認ダイアログは同時に 1 枚だけ。
 *   7. approved を引数で混ぜても効かない（unknown-arg）。患者の値・points が監査ログ・stderr・journal に 0 件。
 *   8. 本物のダイアログに答えないまま 120 秒 → declined（中継は 30 秒で「起動していない」と誤報せずに待つ）。
 *
 * 一時の userData（--user-data-dir）に mcp.json を置いて起動する。前提: backend jar（今のビルド）・frontend の依存・desktop の electron・
 * desktop/mcp/run.cjs（npm run build:mcp）。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { McpStdio } from "./mcpStdioClient.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "mcp-viewer-edit");
const SAMPLE = process.argv[2] ?? path.join(os.homedir(), "graphy-demo-samples", "HASSAKU_DCM");
const CLIENT = "claude-edit-check";

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

interface Roi { roi: string; tool: string; areaMm2?: number; lengthMm?: number }

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userData = path.join(OUT_DIR, "userdata");
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  const prefs = (edit: boolean, control: boolean) => fs.writeFileSync(path.join(userData, "mcp.json"), JSON.stringify({ enabled: true, includePhi: false, allowAnalysis: false, allowViewerControl: control, allowViewerEdit: edit }));
  prefs(false, false);

  const d = new DesktopDriver({}, { extraElectronArgs: [`--user-data-dir=${userData}`] });
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  let mcp: McpStdio | null = null;
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

    // ダイアログのスタブ: 回数・文面・同時に開いた数。mode: accept=最初のボタン、decline=最後のボタン
    await d.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg?: unknown; __orig?: unknown };
      g.__orig = dialog.showMessageBox;
      const st = { log: [] as { title: string; message: string; detail: string; buttons: string[] }[], open: 0, maxOpen: 0, mode: "accept", delay: 0 };
      g.__dlg = st;
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (...a: unknown[]) => {
        const o = (a.length > 1 ? a[1] : a[0]) as { title: string; message: string; detail: string; buttons: string[]; cancelId?: number };
        st.log.push({ title: o.title, message: o.message, detail: o.detail, buttons: o.buttons });
        st.open++;
        st.maxOpen = Math.max(st.maxOpen, st.open);
        if (st.delay) await new Promise((r) => setTimeout(r, st.delay));
        st.open--;
        return { response: st.mode === "accept" ? 0 : (o.cancelId ?? o.buttons.length - 1), checkboxChecked: false };
      };
    });
    type Dlg = { log: { title: string; message: string; detail: string; buttons: string[] }[]; open: number; maxOpen: number; mode: string; delay: number };
    const dlg = (): Promise<Dlg> => d.app.evaluate(() => (globalThis as unknown as { __dlg: Dlg }).__dlg);
    const setDlg = (mode: string, delay = 0) => d.app.evaluate((_a, p) => { const s = (globalThis as unknown as { __dlg: Dlg }).__dlg; s.mode = p.mode; s.delay = p.delay; }, { mode, delay });
    // 操作の確認（ROI の作成・全削除）だけを数える。接続の同意・計測値の返却の確認は別
    const WRITE_TITLE = "外部 AI クライアントの操作の確認";
    const dlgCount = async () => (await dlg()).log.filter((x) => x.title === WRITE_TITLE).length;

    mcp = McpStdio.fromRepo(endpoint, CLIENT);
    await mcp.init();
    const names = async () => (((await mcp!.request("tools/list")).result as { tools: { name: string }[] }).tools ?? []).map((t) => t.name);
    const EDIT = ["create_roi", "create_contour_roi", "clear_measurements"];

    console.log("\n[1] 既定（データを変える許可がオフ）");
    const off = await names();
    check(EDIT.every((n) => !off.includes(n)), "ROI の作成・全削除のツールが一覧に出ない", off.filter((n) => EDIT.includes(n)));
    const roiArgs = { shape: "ellipse", u: 0.5, v: 0.5, radiusXmm: 20, radiusYmm: 10 };
    const denied = await mcp.call("create_roi", roiArgs);
    check(denied.isError && /edit-disabled/.test(denied.text), "オフで呼ぶと edit-disabled", denied.text);
    check((await dlgCount()) === 0, "オフでは操作の確認ダイアログも出ない（画面に触れない）");

    console.log("\n[2] 許可をオン: ROI の作成");
    prefs(true, true); // 表示操作（set_tool）も使う: 手で描く計測の用意
    const on = await names();
    check(EDIT.every((n) => on.includes(n)) && on.includes("undo_viewer_action"), "オンで 3 つのツールと undo が出る", on.filter((n) => EDIT.includes(n)));
    const measurements = async (): Promise<Roi[]> => {
      const r = await mcp!.call("get_measurements");
      if (r.isError) throw new Error(`get_measurements: ${r.text}`);
      return ((r.json as { rois: Roi[] }).rois ?? []);
    };
    const m0 = await measurements(); // 初回の計測値の確認（スタブが承認）
    check(m0.length === 0, "初期は ROI・計測が 0 件", m0);

    // 手で描く計測（Length）。MCP の set_tool で長さのツールにし、キャンバスをドラッグする
    const tool = await mcp.call("set_tool", { tool: "length" });
    check(!tool.isError, "set_tool(length) が通る", tool.text);
    const canvas = viewer.getByTestId("series-viewer-root").first().locator("canvas").first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("キャンバスが無い");
    await viewer.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.8);
    await viewer.mouse.down();
    await viewer.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.8, { steps: 6 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(600);
    const m1 = await measurements();
    check(m1.length === 1 && /length/i.test(m1[0].tool), "手で描いた計測（Length）が 1 件ある", m1);
    const isHand = (r: Roi) => /length/i.test(r.tool); // roi の番号は並びで振り直されるので、道具で見分ける

    const before = await dlgCount();
    const create = await mcp.call("create_roi", roiArgs);
    check(!create.isError, "create_roi（楕円 rx=20 mm・ry=10 mm）が通る", create.text);
    const ask = (await dlg()).log.filter((x) => x.title === WRITE_TITLE).slice(before);
    check(ask.length === 1 && ask[0].message.includes(CLIENT) && /楕円/.test(ask[0].message), "確認が 1 回出て、文面にクライアント名と形がある", ask.map((x) => x.message));
    check(/横 50\.0%/.test(ask[0]?.detail ?? "") && /横 20\.0 mm/.test(ask[0]?.detail ?? "") && /undo_viewer_action/.test(ask[0]?.detail ?? ""), "文面に位置・半径・元に戻す方法がある", ask[0]?.detail);
    await viewer.waitForTimeout(600);
    const m2 = await measurements();
    const made = m2.filter((r) => !isHand(r) && r.areaMm2 !== undefined);
    const want = Math.PI * 20 * 10;
    check(m2.length === 2 && made.length === 1 && Math.abs((made[0].areaMm2 ?? 0) - want) / want < 0.02, `ROI の面積が π·20·10 = ${want.toFixed(1)} mm²（±2%）`, m2);
    await viewer.screenshot({ path: path.join(OUT_DIR, "01-roi-created.png") });

    await setDlg("decline");
    const n1 = (await measurements()).length;
    const dec = await mcp.call("create_roi", { ...roiArgs, u: 0.3, v: 0.3 });
    check(dec.isError && /declined/.test(dec.text), "確認で［取り消す］→ declined", dec.text);
    check((await measurements()).length === n1, "拒否したら ROI は増えない");
    await setDlg("accept");

    console.log("\n[3] 輪郭の ROI");
    const tri = [[0.2, 0.2], [0.6, 0.2], [0.4, 0.6]];
    const c0 = await dlgCount();
    const poly = await mcp.call("create_contour_roi", { shape: "polygon", points: tri });
    check(!poly.isError, "create_contour_roi（三角形）が通る", poly.text);
    check((await dlgCount()) === c0 + 1, "確認が 1 回出た");
    const c1 = await dlgCount();
    const bad: [string, unknown, RegExp][] = [
      ["自己交差（ちょうちょう形）", [[0.1, 0.1], [0.9, 0.9], [0.9, 0.1], [0.1, 0.9]], /self-intersecting/],
      ["面積ゼロ（一直線）", [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]], /degenerate/],
      ["点が 2 個", [[0.1, 0.1], [0.9, 0.9]], /bad-arg:points/],
      ["範囲外", [[0.1, 0.1], [0.9, 0.1], [0.5, 1.4]], /bad-arg:points/],
    ];
    for (const [label, points, re] of bad) {
      const r = await mcp.call("create_contour_roi", { shape: "polygon", points });
      check(r.isError && re.test(r.text), `${label}は符号で断られる`, r.text);
    }
    check((await dlgCount()) === c1, "断られた操作では、確認ダイアログを出していない（dryRun で落ちる）");

    console.log("\n[4] undo は、この接続が作った ROI だけ消す");
    // 履歴は新しい順: 三角形 → 楕円 → set_tool(length)。ROI の 2 つを戻す
    for (let i = 0; i < 2; i++) {
      const r = await mcp.call("undo_viewer_action");
      check(!r.isError, `undo ${i + 1} 回目が通る`, r.text);
      await viewer.waitForTimeout(400);
    }
    const m3 = await measurements();
    check(m3.length === 1 && isHand(m3[0]), "手で描いた計測（Length）は残り、MCP の ROI だけ消えた", m3);
    const toolUndo = await mcp.call("undo_viewer_action"); // 3 つ目は表示操作（ツール）の取り消し
    check(!toolUndo.isError, "3 つ目の undo はツール切替の取り消し（表示操作と同じ履歴）", toolUndo.text);
    const empty = await mcp.call("undo_viewer_action");
    check(empty.isError && /nothing-to-undo/.test(empty.text), "履歴が尽きたら nothing-to-undo", empty.text);
    check((await measurements()).some(isHand), "履歴が尽きても、手で描いた計測は残る");
    await viewer.screenshot({ path: path.join(OUT_DIR, "02-after-undo.png") });

    console.log("\n[5] 計測の全削除（元に戻せない）");
    await setDlg("decline");
    const c2 = await dlgCount();
    const clr0 = await mcp.call("clear_measurements");
    check(clr0.isError && /declined/.test(clr0.text), "［取り消す］→ declined", clr0.text);
    check((await measurements()).length === 1, "拒否したら計測は残る");
    const clearAsk = (await dlg()).log.filter((x) => x.title === WRITE_TITLE).slice(c2);
    check(clearAsk.length === 1 && /^元に戻せません。/.test(clearAsk[0].detail) && clearAsk[0].buttons[0] === "削除する", "確認の文面は「元に戻せません。」で始まる", clearAsk[0]);
    await setDlg("accept");
    const clr = await mcp.call("clear_measurements");
    check(!clr.isError && /irreversible/.test(clr.text), "承認で実行され、irreversible が付く", clr.text);
    await viewer.waitForTimeout(600);
    check((await measurements()).length === 0, "計測が 0 件になった");
    const und = await mcp.call("undo_viewer_action");
    check(und.isError && /nothing-to-undo/.test(und.text), "全削除は undo で戻せない（nothing-to-undo）", und.text);

    console.log("\n[6] ダイアログの直列化");
    await setDlg("accept", 350);
    const r3 = await Promise.all([0.3, 0.5, 0.7].map((u) => mcp!.call("create_roi", { ...roiArgs, u, radiusXmm: 5, radiusYmm: 5 })));
    check(r3.every((r) => !r.isError), "同時に呼んだ 3 つの create_roi がすべて通る", r3.map((r) => r.text));
    const st = await dlg();
    check(st.maxOpen === 1, "確認ダイアログが同時に開いた最大数は 1", st.maxOpen);
    await setDlg("accept", 0);
    for (let i = 0; i < 3; i++) await mcp.call("undo_viewer_action");

    console.log("\n[7] approved の混入・患者情報");
    const c3 = await dlgCount();
    const body = JSON.stringify({ tool: "create_roi", args: { ...roiArgs, approved: true } });
    const tok = JSON.parse(fs.readFileSync(endpoint, "utf8")) as { port: number; token: string };
    const raw = await new Promise<{ status: number; text: string }>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: tok.port, method: "POST", path: "/v1/call", headers: { authorization: `Bearer ${tok.token}`, "x-graphy-mcp-client": CLIENT, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
        let t = "";
        res.on("data", (c: Buffer) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: t }));
      });
      req.write(body);
      req.end();
    });
    check(/unknown-arg:approved/.test(raw.text) && (await dlgCount()) === c3, "approved を引数で混ぜても unknown-arg（確認も出ない）", raw.text);
    const audit = fs.readFileSync(path.join(userData, "mcp-audit.jsonl"), "utf8");
    const journalFile = path.join(userData, "assistant-journal.jsonl");
    const journal = fs.existsSync(journalFile) ? fs.readFileSync(journalFile, "utf8") : "";
    check(truth.length > 0 && truth.every((v) => !audit.includes(v) && !journal.includes(v) && !mcp!.stderr.includes(v)), "監査ログ・journal・stderr に患者の値が 0 件", { truthKinds: truth.length });
    check(!/\[\[|"points"\s*:/.test(audit) && !/\[\[|"points"\s*:/.test(journal), "監査ログ・journal に points（輪郭の頂点の値）が残らない");
    check(/create_roi/.test(audit) && /clear_measurements/.test(audit), "監査ログに呼び出し（ツール名）が残る");

    console.log("\n[8] 本物のダイアログに答えないまま 120 秒");
    await d.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __orig?: typeof dialog.showMessageBox };
      if (g.__orig) (dialog as unknown as { showMessageBox: unknown }).showMessageBox = g.__orig;
    });
    const t0 = Date.now();
    const slow = await mcp.call("create_roi", { ...roiArgs, u: 0.8, v: 0.8 }, 240_000);
    const sec = (Date.now() - t0) / 1000;
    check(slow.isError && /declined/.test(slow.text), "答えないまま過ぎると declined（自動で取り消し）", slow.text);
    check(sec >= 110 && sec <= 200, `約 120 秒待ってから取り消された（${sec.toFixed(0)} 秒。中継は 30 秒で「起動していない」と誤報しない）`, sec);
    check(!/起動していない/.test(slow.text), "待ち時間の間、「起動していない」の誤報が出ていない");
    const alive = await mcp.call("get_status");
    check(!alive.isError, "自動取り消しの後も受け口は生きている", alive.text);
  } finally {
    mcp?.close();
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

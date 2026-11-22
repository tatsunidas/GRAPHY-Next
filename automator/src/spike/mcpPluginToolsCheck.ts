/*
 * MCP のプラグインの AI ツール（plugin__<id>__<tool>。公開するプラグインは mcp.json の pluginTools）の実機検証（段 4c-2b。
 * roadmap fw/mcp-server-design.md §6）。実際の中継（desktop/mcpCli.js、stdio）から呼び、実際の 2D 窓でプラグインのコードを動かす。
 * 確認ダイアログは dialog.showMessageBox のスタブ（回数・文面を記録。応答を切り替え）。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=19540 GRAPHY_AUTOMATOR_SCP_PORT=19541 GRAPHY_AUTOMATOR_VITE_PORT=19543 \
 *          npx tsx src/spike/mcpPluginToolsCheck.ts [検査のフォルダ（既定 ~/graphy-demo-samples/HASSAKU_DCM）]
 *
 *   1. 既定（公開するプラグインが空）: plugin__ のツールが出ない／名前を直接呼んでも unknown-tool。
 *   2. 環境設定の IPC（setMcp）で公開 → 確認（ツールの一覧）が出る。見つからない ID は unknown-plugin。write のツールは編集の許可がなければ出ない。
 *   3. read・display のツール: untrusted・source・確認（結果の先頭。クライアント × プラグインで 1 回）・4 KB 切り捨て・plugin-error（本文なし）・引数違反。
 *   4. write のツール（tag_roi）: 編集の許可がなければ edit-disabled／あれば実行のたびに確認（拒否で何も起きない・承認で書かれて読み戻せる）。
 *   5. 効果の偽装（liar）は effect-violation。ai-tools の権限が無いプラグインは公開できない。公開していないプラグインは unknown-tool。
 *   6. approved を引数で混ぜても効かない。患者の値が監査ログ・stderr に 0 件。
 *
 * 一時の userData（--user-data-dir）で起動する。プラグインは DESKTOP_RUN_DATA_DIR/plugins に入れる（起動前。backend が起動時に読む）。
 * 前提: backend jar（今のビルド）・frontend の依存・desktop の electron・desktop/mcp/run.cjs（npm run build:mcp）。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { McpStdio } from "./mcpStdioClient.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "mcp-plugin-tools");
const SAMPLE = process.argv[2] ?? path.join(os.homedir(), "graphy-demo-samples", "HASSAKU_DCM");
const PLUGINS = ["ai-tools-demo", "ai-tools-liar", "ai-tools-noperm"];
const D = "plugin__ai-tools-demo__";
const L = "plugin__ai-tools-liar__";

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

function installPlugins(): void {
  for (const id of PLUGINS) {
    const src = path.join(AUTOMATOR_ROOT, "plugins", id);
    const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", id);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) fs.copyFileSync(path.join(src, name), path.join(dst, name));
  }
}
const removePlugins = () => PLUGINS.forEach((id) => fs.rmSync(path.join(DESKTOP_RUN_DATA_DIR, "plugins", id), { recursive: true, force: true }));

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugins();
  const userData = path.join(OUT_DIR, "userdata");
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  const prefsFile = path.join(userData, "mcp.json");
  const writePrefs = (p: { edit: boolean; control: boolean; plugins: string[] }) => fs.writeFileSync(prefsFile, JSON.stringify({ enabled: true, includePhi: false, allowAnalysis: false, allowViewerControl: p.control, allowViewerEdit: p.edit, pluginTools: p.plugins }));
  writePrefs({ edit: false, control: true, plugins: [] });

  const d = new DesktopDriver({}, { extraElectronArgs: [`--user-data-dir=${userData}`] });
  let mcp: McpStdio | null = null;
  let other: McpStdio | null = null;
  try {
    await d.start();
    const base = `http://127.0.0.1:${d.ports.http}`;
    await resetDb(d.ports.http);
    await importPaths(d.ports.http, [SAMPLE]);
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { patientName?: string; patientId?: string; studyInstanceUid: string }[];
    const truth = [studies[0]?.patientName, studies[0]?.patientId, studies[0]?.studyInstanceUid].filter((v): v is string => typeof v === "string" && v.trim().length >= 3);
    const plugins = (await (await fetch(`${base}/api/plugins`)).json()) as { id: string }[];
    check(PLUGINS.filter((p) => p !== "ai-tools-noperm").every((id) => plugins.some((p) => p.id === id)), "backend がプラグインを読み込んでいる", plugins.map((p) => p.id));

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
      const st = { log: [] as { title: string; message: string; detail: string }[], mode: "accept" };
      (globalThis as unknown as { __dlg: unknown }).__dlg = st;
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (...a: unknown[]) => {
        const o = (a.length > 1 ? a[1] : a[0]) as { title: string; message: string; detail: string; buttons: string[]; cancelId?: number };
        st.log.push({ title: o.title, message: o.message, detail: o.detail });
        return { response: st.mode === "accept" ? 0 : (o.cancelId ?? o.buttons.length - 1), checkboxChecked: false };
      };
    });
    type Dlg = { log: { title: string; message: string; detail: string }[]; mode: string };
    const dlg = (): Promise<Dlg> => d.app.evaluate(() => (globalThis as unknown as { __dlg: Dlg }).__dlg);
    const setMode = (mode: string) => d.app.evaluate((_a, m) => { (globalThis as unknown as { __dlg: Dlg }).__dlg.mode = m; }, mode);
    const log = async (re: RegExp) => (await dlg()).log.filter((x) => re.test(x.message));
    const setMcp = (patch: Record<string, unknown>) =>
      mainPage.evaluate((p) => (window as unknown as { graphyDesktop: { setMcp: (x: unknown) => Promise<{ ok: boolean; error?: string; state?: { prefs: { pluginTools: string[] } } }> } }).graphyDesktop.setMcp(p), patch);

    mcp = McpStdio.fromRepo(endpoint, "claude-plugin-check");
    await mcp.init();
    const names = async (m: McpStdio) => (((await m.request("tools/list")).result as { tools: { name: string; description?: string; inputSchema?: unknown }[] }).tools ?? []);

    console.log("\n[1] 既定（公開するプラグインが空）");
    check((await names(mcp)).every((t) => !t.name.startsWith("plugin__")), "plugin__ のツールが一覧に出ない");
    const direct = await mcp.call(`${D}echo_size`, { n: 3 });
    check(direct.isError && /unknown-tool/.test(direct.text), "名前を直接呼んでも unknown-tool", direct.text);

    console.log("\n[2] 環境設定（IPC）で公開する");
    const missing = await setMcp({ pluginTools: ["no-such-plugin"] });
    check(!missing.ok && missing.error === "unknown-plugin", "見つからない ID は unknown-plugin", missing);
    await setMode("decline");
    const declinedExpose = await setMcp({ pluginTools: ["ai-tools-demo"] });
    check(!declinedExpose.ok && declinedExpose.error === "cancelled", "公開の確認で［やめる］→ cancelled（公開されない）", declinedExpose);
    await setMode("accept");
    const exposed = await setMcp({ pluginTools: ["ai-tools-demo"] });
    check(exposed.ok && JSON.stringify(exposed.state?.prefs.pluginTools) === JSON.stringify(["ai-tools-demo"]), "公開できる", exposed);
    const expose = await log(/ツールを公開します/);
    check(expose.length >= 1 && /echo_size（読み取り）/.test(expose.at(-1)!.detail) && /tag_roi（データを変更。実行のたびに確認）/.test(expose.at(-1)!.detail), "公開の確認に、ツールと効果の一覧が出る", expose.at(-1)?.detail);
    const noperm = await setMcp({ pluginTools: ["ai-tools-demo", "ai-tools-noperm"] });
    check(!noperm.ok && noperm.error === "unknown-plugin", "ai-tools の権限が無いプラグインは公開できない（unknown-plugin）", noperm);

    const listed = await names(mcp);
    const pt = listed.filter((t) => t.name.startsWith("plugin__"));
    check(pt.length > 0 && pt.every((t) => t.name.startsWith(D)), "公開したプラグインのツールだけが出る", pt.map((t) => t.name));
    check(!pt.some((t) => t.name === `${D}tag_roi`), "write のツール（tag_roi）は、編集の許可がないと出ない", pt.map((t) => t.name));
    const echo = pt.find((t) => t.name === `${D}echo_size`);
    check(!!echo && /\[plugin: /.test(echo.description ?? "") && /信用できない文字列/.test(echo.description ?? ""), "説明に main の名乗りと「信用できない文字列」がある", echo?.description);

    console.log("\n[3] read・display のツール");
    const c0 = (await log(/ツールの結果を、外部 AI クライアント/)).length;
    const r1 = await mcp.call(`${D}echo_size`, { n: 3 });
    check(!r1.isError, "echo_size が通る", r1.text);
    const j1 = r1.json as { untrusted?: boolean; source?: string; data?: unknown } | null;
    check(j1?.untrusted === true && j1?.source === "plugin:ai-tools-demo", "結果に untrusted と source が付く", j1);
    const send = (await log(/ツールの結果を、外部 AI クライアント/)).slice(c0);
    check(send.length === 1 && /claude-plugin-check/.test(send[0].message) && /信用できない文字列/.test(send[0].detail), "結果を返す前の確認が 1 回出る（クライアント名・信用できない文字列）", send.map((x) => x.message));
    await mcp.call(`${D}echo_size`, { n: 4 });
    check((await log(/ツールの結果を、外部 AI クライアント/)).length === c0 + 1, "同じクライアント × プラグインでは、2 回目の確認は出ない");
    const mark = await mcp.call(`${D}mark_display`, { n: 2 });
    check(!mark.isError, "display のツール（mark_display）が通る", mark.text);
    const big = await mcp.call(`${D}big_probe`, {});
    check(!big.isError && (big.json as { truncated?: boolean } | null)?.truncated === true && big.text.length < 6000, "大きな結果は切り捨てられ truncated が付く", { len: big.text.length });
    const boom = await mcp.call(`${D}boom`, {});
    check(boom.isError && /plugin-error/.test(boom.text) && !/at |Error:/.test(boom.text), "プラグインの例外は plugin-error（本文を返さない）", boom.text);
    for (const [args, re] of [[{ n: 99 }, /bad-arg:n/], [{ n: "3" }, /bad-arg:n/], [{}, /missing-arg:n/], [{ n: 3, approved: true }, /unknown-arg:approved/]] as [Record<string, unknown>, RegExp][]) {
      const r = await mcp.call(`${D}echo_size`, args);
      check(r.isError && re.test(r.text), `引数 ${JSON.stringify(args)} は ${re.source}`, r.text);
    }
    // 結果の先頭の確認は、新しい接続で出る（phi_probe は患者名風の値を返す。利用者は拒否できる）
    other = McpStdio.fromRepo(endpoint, "claude-other-client");
    await other.init();
    await names(other); // 最初の接続の同意（許可）
    await setMode("decline");
    const probe = await other.call(`${D}phi_probe`, {});
    const probeAsk = (await log(/ツールの結果を、外部 AI クライアント/)).at(-1);
    check(probe.isError && /declined/.test(probe.text), "患者名風の値を返すツール: 結果の確認で拒否 → declined（返らない）", probe.text);
    check(/claude-other-client/.test(probeAsk?.message ?? "") && /先頭/.test(probeAsk?.detail ?? ""), "確認の文面に結果の先頭が出る（利用者が見て判断できる）", probeAsk?.detail?.slice(0, 120));
    await setMode("accept");

    console.log("\n[4] write のツール（編集の許可）");
    const denied = await mcp.call(`${D}tag_roi`, { tag: "mcp-tag" });
    check(denied.isError && /edit-disabled/.test(denied.text), "編集の許可がなければ edit-disabled", denied.text);
    writePrefs({ edit: true, control: true, plugins: ["ai-tools-demo"] });
    check((await names(mcp)).some((t) => t.name === `${D}tag_roi`), "編集の許可をオンにすると tag_roi が出る");
    const roi = await mcp.call("create_roi", { shape: "ellipse", u: 0.5, v: 0.5, radiusXmm: 15, radiusYmm: 10 });
    check(!roi.isError, "（準備）create_roi で ROI を 1 つ作る", roi.text);
    await viewer.waitForTimeout(500);
    const w0 = (await log(/データを変更します/)).length;
    await setMode("decline");
    const tagNo = await mcp.call(`${D}tag_roi`, { tag: "mcp-tag" });
    check(tagNo.isError && /declined/.test(tagNo.text), "実行の確認で［取り消す］→ declined", tagNo.text);
    const readNo = await mcp.call(`${D}read_tag`, {});
    check(!/mcp-tag/.test(readNo.text), "拒否したら書かれていない", readNo.text);
    await setMode("accept");
    const tagYes = await mcp.call(`${D}tag_roi`, { tag: "mcp-tag" });
    check(!tagYes.isError, "承認で tag_roi が実行される", tagYes.text);
    const asks = (await log(/データを変更します/)).slice(w0);
    check(asks.length === 2 && /claude-plugin-check/.test(asks[1].message) && /tag_roi/.test(asks[1].message) && /mcp-tag/.test(asks[1].detail) && /信用できない文字列/.test(asks[1].detail), "実行のたびに確認が出る（クライアント名・ツール・引数・信用できない文字列）", asks.map((x) => x.message));
    check(!/外部の計算機/.test(asks[1].detail), "remote-compute の無いプラグインには、外部送信の注記を出さない");
    const readYes = await mcp.call(`${D}read_tag`, {});
    check(/mcp-tag/.test(readYes.text), "書かれた値が読み戻せる", readYes.text);
    await mcp.call("undo_viewer_action"); // ROI を消す

    console.log("\n[5] 効果の偽装・権限・公開していないもの");
    writePrefs({ edit: false, control: true, plugins: ["ai-tools-demo", "ai-tools-liar"] });
    const lnames = (await names(mcp)).filter((t) => t.name.startsWith(L)).map((t) => t.name);
    check(lnames.includes(`${L}liar_read`) && !lnames.includes(`${L}honest_write`), "liar の read・display のツールが出る（write は出ない）", lnames);
    const honest = await mcp.call(`${L}honest_read`, {});
    check(!honest.isError, "honest_read は通る", honest.text);
    for (const t of ["liar_read", "liar_swallow"]) {
      const r = await mcp.call(`${L}${t}`, {});
      check(r.isError && /effect-violation/.test(r.text), `${t}（read と宣言して ROI を作ろうとする）は effect-violation`, r.text);
    }
    check((await mcp.call(`${L}honest_write`, {})).isError, "honest_write（write）は編集の許可なしでは通らない");
    writePrefs({ edit: false, control: true, plugins: ["ai-tools-demo"] });
    const hidden = await mcp.call(`${L}honest_read`, {});
    check(hidden.isError && /unknown-tool/.test(hidden.text), "公開していないプラグインは、名前を直接呼んでも unknown-tool", hidden.text);
    const noName = await mcp.call("plugin__ai-tools-noperm__t", {});
    check(noName.isError && /unknown-tool/.test(noName.text), "権限の無いプラグインは unknown-tool");

    console.log("\n[6] 患者情報");
    const audit = fs.readFileSync(path.join(userData, "mcp-audit.jsonl"), "utf8");
    check(truth.length > 0 && truth.every((v) => !audit.includes(v) && !mcp!.stderr.includes(v) && !other!.stderr.includes(v)), "監査ログ・stderr に患者の値が 0 件", { truthKinds: truth.length });
    check(/plugin__ai-tools-demo__echo_size/.test(audit), "監査ログにツール名が残る");
  } finally {
    mcp?.close();
    other?.close();
    await d.stop();
    removePlugins();
  }
  console.log(`\n=== ${passed} 件合格 / ${failures.length} 件失敗 ===`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  removePlugins();
  process.exit(1);
});

/*
 * プラグインの AI ツール（S5c: plugin.json の aiTools[]）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantPluginToolsCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓 ＋ 検証用プラグイン（ai-tools-demo / ai-tools-noperm）
 * ＋ loopback の偽 OpenAI 互換サーバー。main の確認ダイアログ（dialog.showMessageBox）はスタブし、節の終わりで元に戻す。
 * 確かめること:
 *   1. 🔴 一覧: 宣言したツール（read / write）が出る。権限なしプラグインのツールは出ない。既定はオフ
 *   2. 🔴 オフのままモデルが呼んでも 2D 窓のプラグインは動かない（モデルに渡る tools にも載らない）
 *   3. 🔴 オンにすると tools に載り、説明の名乗りは main が付ける（プラグインの偽の名乗りは本文に残るが先頭は本物）
 *   4. 実行: 2D 窓で関数が呼ばれ（activate は呼ばれない）、結果は untrusted で包まれてモデルへ返る。カードが出る
 *   5. 🔴 結果の中の「命令」に従わない（フレーム: 結果は tool メッセージのデータ）。ジャーナルに結果の中身が残らない
 *   6. 🔴 例外の本文はモデルへ返らない（plugin-error）。4 KB を超える結果は切り捨てられる
 *   7. 🔴 負例: モデルが権限なしのツールを呼んでも動かない。IPC を偽っても（pluginId 偽装・未知の名前）動かない。メイン窓は forbidden
 *   9. 🔴 write: 実行のたびに main の確認が出て（2 回目も）、拒否では呼ばれず ROI の属性が変わらない。承認で変わる。read は確認なし。
 *      IPC に approved:true を偽っても、確認が拒否されれば動かない
 * 未達として残すもの: 外部 AI 宛ての結果送信前の確認（loopback でしか鍵なし提供元を作れないため実機では出せない。単体テストのみ）／
 *   実モデルがツールを適切に選ぶか／実 OS のネイティブ確認の見た目／悪意あるプラグインが renderer から直接 IPC を呼ぶ経路。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Page } from "playwright";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-plugin-tools-check");
const PORTS = { http: 19380, scp: 19381, vite: 19383 };
const PLUGIN_IDS = ["ai-tools-demo", "ai-tools-noperm"];
const P = "plugin__ai-tools-demo__";
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Msg { role: string; content?: unknown; tool_call_id?: string }
const seen: { messages: Msg[]; tools: string[] }[] = [];

const SCRIPT: Record<string, { name: string; args: unknown }> = {
  CALLECHO: { name: `${P}echo_size`, args: { n: 3 } },
  CALLPHI: { name: `${P}phi_probe`, args: {} },
  CALLBOOM: { name: `${P}boom`, args: {} },
  CALLBIG: { name: `${P}big_probe`, args: {} },
  CALLTAG: { name: `${P}tag_roi`, args: { tag: "AI1" } },
  CALLSECOND: { name: `${P}tag_roi`, args: { tag: "AI2" } },
  CALLREAD: { name: `${P}read_tag`, args: {} },
  CALLNOPERM: { name: "plugin__ai-tools-noperm__t", args: {} },
  CALLBAD: { name: `${P}echo_size`, args: { n: 99 } },
};

function startFake(port: number) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: { messages?: Msg[]; stream?: boolean; tools?: { function?: { name?: string } }[] } = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* */ }
      const messages = body.messages ?? [];
      seen.push({ messages, tools: (body.tools ?? []).map((t) => t.function?.name ?? "") });
      const last = messages[messages.length - 1];
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
      const key = Object.keys(SCRIPT).find((k) => userText.includes(k));
      const wantCall = !!key && last?.role !== "tool";
      const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
      if (!body.stream) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "OK" } }] })); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (wantCall) {
        const c = SCRIPT[key!];
        const argStr = JSON.stringify(c.args);
        res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${key}`, function: { name: c.name, arguments: argStr.slice(0, 3) } }] } }] }));
        res.write(sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argStr.slice(3) } }] }, finish_reason: "tool_calls" }] }));
      } else {
        res.write(sse({ choices: [{ delta: { content: "完了しました。" }, finish_reason: "stop" }] }));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

function installPlugins(): void {
  for (const id of PLUGIN_IDS) {
    const src = path.join(AUTOMATOR_ROOT, "plugins", id);
    const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", id);
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) fs.copyFileSync(path.join(src, name), path.join(dst, name));
  }
}
function removePlugins(): void {
  for (const id of PLUGIN_IDS) fs.rmSync(path.join(DESKTOP_RUN_DATA_DIR, "plugins", id), { recursive: true, force: true });
}

/** 「新しい版があります」ダイアログは通信状況で出て、クリックを遮る。DOM で「後で」を押して閉じる。 */
async function dismissUpdate(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`(function(){ var b=[].slice.call(document.querySelectorAll("button")).find(function(x){return /^(後で|Later)$/.test((x.textContent||"").trim());}); if(b) b.click(); })()`).catch(() => undefined);
    await sleep(500);
  }
}

type DemoState = { calls: { tool: string; args: unknown; pluginId?: string }[] } | undefined;

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fakePort = await freePort();
  const fake = startFake(fakePort);
  installPlugins();
  const driver = new DesktopDriver(PORTS);
  let dataDir = "";
  const clean = () => {
    for (const f of ["ai-providers.json", "secrets.enc.json"]) {
      if (dataDir && fs.existsSync(path.join(dataDir, f))) fs.rmSync(path.join(dataDir, f));
    }
  };
  try {
    await driver.start();
    const info = await driver.app.evaluate(({ dialog, app }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return { cwd: process.cwd(), userData: app.getPath("userData") };
    });
    dataDir = info.cwd;
    clean();
    const toggleFile = path.join(info.userData, "assistant-plugin-tools.json");
    const journalFile = path.join(info.userData, "assistant-journal.jsonl");
    for (const f of [toggleFile, journalFile, `${journalFile}.1`]) if (fs.existsSync(f)) fs.rmSync(f);
    const main: Page = driver.page;
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await dismissUpdate(main);
    await openFirstSeriesInViewer(main, createStepRecorder());
    await dismissUpdate(main);
    const viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2500);
    const demo = () => viewer.evaluate(() => (window as unknown as { __aiToolsDemo?: DemoState }).__aiToolsDemo) as Promise<DemoState>;
    const activated = () => viewer.evaluate(() => (window as unknown as { __aiToolsDemoActivated?: number }).__aiToolsDemoActivated ?? 0);
    const noperm = () => viewer.evaluate(() => (window as unknown as { __aiToolsNoperm?: number }).__aiToolsNoperm ?? 0);

    const local = { id: "local", label: "ローカル LLM", kind: "openai", endpoint: `http://127.0.0.1:${fakePort}`, auth: "none", models: { "text-to-text": "tiny" } };
    const set = await main.evaluate(
      (cfg) => (window as unknown as { graphyDesktop: { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean }> } }).graphyDesktop.aiProvidersSet(cfg),
      { providers: [local], defaults: { "text-to-text": "local" } },
    );
    check(set.ok === true, "ローカル提供元（native tools）を保存できる", set);
    // 確認ダイアログのスタブ（ローカル宛なら呼ばれないはず）。節の終わりで必ず元に戻す。
    await driver.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg: { n: number; orig: unknown; response: number; last: unknown } };
      g.__dlg = { n: 0, orig: dialog.showMessageBox, response: 1, last: null };
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (_w: unknown, o: unknown) => {
        g.__dlg.n++;
        g.__dlg.last = o;
        return { response: g.__dlg.response, checkboxChecked: false };
      };
    });
    const dlgCount = () => driver.app.evaluate(() => (globalThis as unknown as { __dlg: { n: number } }).__dlg.n);
    const dlgLast = () => driver.app.evaluate(() => (globalThis as unknown as { __dlg: { last: { message?: string; detail?: string; defaultId?: number; buttons?: string[] } | null } }).__dlg.last);
    const setResponse = (r: number) => driver.app.evaluate((_a, v) => { (globalThis as unknown as { __dlg: { response: number } }).__dlg.response = v; }, r);

    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.setViewportSize({ width: 560, height: 800 });
    await win.getByTestId("assistant-input").waitFor({ state: "visible" });
    await sleep(800);
    const ask = async (q: string) => {
      await win.getByTestId("assistant-input").fill(q);
      await win.getByTestId("assistant-send").click();
      await win.getByTestId("assistant-send").waitFor({ state: "visible", timeout: 30_000 });
      await sleep(400);
    };
    type Entry = { name: string; pluginId: string; tool: string; effect?: string; description: string; enabled: boolean };
    const list = () => win.evaluate(() => (window as unknown as { graphyDesktop: { assistantPluginToolsList: () => Promise<{ ok: boolean; tools?: Entry[] }> } }).graphyDesktop.assistantPluginToolsList());
    const cmd = (c: unknown) => win.evaluate((x) => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<{ ok: boolean; error?: string; data?: unknown }> } }).graphyDesktop.assistantViewerCmd("spike", x), c);
    const lastToolMsg = (): string => {
      for (let i = seen.length - 1; i >= 0; i--) {
        const t = [...seen[i].messages].reverse().find((m) => m.role === "tool");
        if (t) return typeof t.content === "string" ? t.content : JSON.stringify(t.content);
      }
      return "";
    };

    // --- 1. 一覧 ---
    console.log("\n[1] 一覧（宣言したもの・既定オフ）");
    const l0 = await list();
    const names = (l0.tools ?? []).map((t) => t.name).sort();
    check(l0.ok === true && names.length === 6, "宣言したツール 6 件が出る（echo_size / phi_probe / boom / big_probe / tag_roi / read_tag）", names);
    const tagEntry = (l0.tools ?? []).find((t) => t.tool === "tag_roi");
    check(tagEntry?.effect === "write" && tagEntry.description.startsWith("[plugin: AI Tools Demo] (writes data) "), "🔴 write の宣言は effect:write で出て、説明に (writes data) が付く", tagEntry);
    check((l0.tools ?? []).filter((t) => t.effect === "write").length === 1, "対照: write は tag_roi の 1 件だけ（他は read）", (l0.tools ?? []).map((t) => [t.tool, t.effect]));
    check(!names.some((n) => n.includes("noperm")), "🔴 ai-tools 権限の無いプラグインのツールは一覧に出ない", names);
    check((l0.tools ?? []).every((t) => t.enabled === false), "🔴 既定はすべてオフ", l0.tools?.map((t) => t.enabled));
    const echo = (l0.tools ?? []).find((t) => t.tool === "echo_size");
    check(!!echo && echo.description.startsWith("[plugin: AI Tools Demo] ") && !/\n/.test(echo.description), "説明の先頭の名乗りは main が付け、改行は畳まれる", echo?.description);

    // --- 2. オフのまま呼ばれる ---
    console.log("\n[2] オフのままモデルが呼ぶ");
    const s0 = seen.length;
    await ask("CALLECHO お願い");
    check(seen.slice(s0).every((r) => !r.tools.some((n) => n.startsWith("plugin__"))), "🔴 オフのとき tools にプラグインのツールは載らない", seen.slice(s0).map((r) => r.tools));
    check(JSON.parse(lastToolMsg() || "{}").error === "unknown-tool", "モデルが呼んでも unknown-tool", lastToolMsg());
    check(!(await demo())?.calls?.length, "🔴 2D 窓のプラグインは動いていない", await demo());

    // --- 3. オンにする ---
    console.log("\n[3] パネルでオンにする");
    await win.getByTestId("assistant-plugintools-toggle").click();
    await win.getByTestId("assistant-plugintools-panel").waitFor({ state: "visible", timeout: 10_000 });
    check((await win.getByTestId("assistant-plugintools-ai-tools-demo").count()) === 1, "パネルにプラグインが出る");
    check((await win.getByTestId("assistant-plugintools-ai-tools-noperm").count()) === 0, "権限なしのプラグインはパネルにも出ない");
    check((await win.getByTestId("assistant-plugintools-write-ai-tools-demo-tag_roi").count()) === 1 && (await win.getByTestId("assistant-plugintools-write-ai-tools-demo-echo_size").count()) === 0, "パネルの「書き込み」バッジは write のツールだけに出る");
    await win.screenshot({ path: path.join(OUT_DIR, "1-panel-off.png") });
    await win.getByTestId("assistant-plugintools-toggle-ai-tools-demo").click();
    await sleep(500);
    check(await win.getByTestId("assistant-plugintools-toggle-ai-tools-demo").isChecked(), "チェックボックスがオンの表示になる");
    await sleep(800);
    const l1 = await list();
    check((l1.tools ?? []).every((t) => t.enabled === true), "オンにすると一覧が enabled になる", l1.tools?.map((t) => t.enabled));
    check(fs.existsSync(toggleFile) && JSON.parse(fs.readFileSync(toggleFile, "utf8")).enabled?.[0] === "ai-tools-demo", "main が userData に保存した", fs.existsSync(toggleFile) && fs.readFileSync(toggleFile, "utf8"));
    await win.screenshot({ path: path.join(OUT_DIR, "2-panel-on.png") });

    // --- 4. 実行 ---
    console.log("\n[4] 実行");
    const act0 = await activated();
    const s1 = seen.length;
    await ask("CALLECHO お願い");
    check(seen[s1].tools.includes(`${P}echo_size`) && seen[s1].tools.includes(`${P}tag_roi`), "オンで tools に載る（write のツールも載る。実行は確認つき）", seen[s1].tools);
    const d1 = await demo();
    check(d1?.calls?.length === 1 && d1.calls[0].tool === "echo_size" && JSON.stringify(d1.calls[0].args) === '{"n":3}' && d1.calls[0].pluginId === "ai-tools-demo", "2D 窓でプラグインの関数が呼ばれた（引数・pluginId）", d1);
    check((await activated()) === act0, "🔴 activate は呼ばれない", { before: act0, after: await activated() });
    const r1 = JSON.parse(lastToolMsg());
    check(r1.ok === true && r1.untrusted === true && r1.source === "plugin:ai-tools-demo" && r1.data?.n === 3, "結果は untrusted で包まれてモデルへ返る", r1);
    check((await win.getByTestId(`assistant-action-${P}echo_size`).count()) === 1, "ツール呼び出しのカードが出る");
    const cardText = (await win.getByTestId(`assistant-action-${P}echo_size`).first().textContent()) ?? "";
    check(!/assistant\.act\./.test(cardText) && /ai-tools-demo/.test(cardText), "カードに未翻訳キーが出ない", cardText);
    await win.screenshot({ path: path.join(OUT_DIR, "3-echo-card.png") });

    // --- 5. PHI を含む結果 ---
    console.log("\n[5] 結果の中身");
    const dl0 = await dlgCount();
    await ask("CALLPHI お願い");
    const r5 = JSON.parse(lastToolMsg());
    check(r5.ok === true && r5.untrusted === true && /SECRET\^PHI/.test(JSON.stringify(r5.data)), "ローカル宛なので結果はそのまま返る（untrusted 付き）", r5);
    check((await dlgCount()) === dl0, "ローカル宛は確認ダイアログが出ない", await dlgCount());
    const journal = fs.existsSync(journalFile) ? fs.readFileSync(journalFile, "utf8") : "";
    check(/"kind":"pluginTool"/.test(journal) && /ai-tools-demo:phi_probe/.test(journal), "ジャーナルに pluginTool の呼び出しが残る", journal.slice(-300));
    check(!/SECRET|ignore all previous/.test(journal), "🔴 ジャーナルに結果の中身が残らない");
    check((await demo())?.calls?.filter((c) => c.tool !== "echo_size" && c.tool !== "phi_probe").length === 0, "結果の中の命令では何も呼ばれない");

    // --- 6. 例外・大きい結果・不正な引数 ---
    console.log("\n[6] 例外・サイズ・不正な引数");
    await ask("CALLBOOM お願い");
    const r6 = lastToolMsg();
    check(JSON.parse(r6).error === "plugin-error" && !/BOOM-SECRET/.test(r6), "🔴 例外は plugin-error のみで本文はモデルに返らない", r6);
    await ask("CALLBIG お願い");
    const r6b = JSON.parse(lastToolMsg());
    check(r6b.truncated === true && JSON.stringify(r6b).length < 6000, "🔴 4 KB を超える結果は切り捨てられる", { truncated: r6b.truncated, len: JSON.stringify(r6b).length });
    const callsBefore = (await demo())?.calls?.length ?? 0;
    await ask("CALLBAD お願い");
    check(JSON.parse(lastToolMsg()).error === "out-of-range:n" && ((await demo())?.calls?.length ?? 0) === callsBefore, "🔴 範囲外の引数は 2D 窓まで届かない", lastToolMsg());

    // --- 7. 負例 ---
    console.log("\n[7] 負例");
    const c7 = ((await demo())?.calls?.length ?? 0);
    await ask("CALLNOPERM お願い");
    check(JSON.parse(lastToolMsg()).error === "unknown-tool" && (await noperm()) === 0, "🔴 権限なしプラグインのツールは動かない", { out: lastToolMsg(), noperm: await noperm() });
    const forged = [
      { kind: "pluginTool", name: `${P}nope`, params: {} },
      { kind: "pluginTool", name: "plugin__ai-tools-noperm__t", params: {} },
      { kind: "pluginTool", name: "plugin__evil__x", pluginId: "ai-tools-demo", tool: "tag_roi", params: { tag: "X" } },
      { kind: "pluginTool", pluginId: "ai-tools-demo", tool: "tag_roi", params: { tag: "X" } },
    ];
    for (const f of forged) {
      const r = await cmd(f);
      check(r.ok === false && r.error === "unknown-tool", `🔴 偽装した IPC（${JSON.stringify(f).slice(0, 70)}）は unknown-tool`, r);
    }
    check(((await demo())?.calls?.length ?? 0) === c7 && (await noperm()) === 0, "🔴 偽装した IPC のあとも 2D 窓のプラグインは動いていない");
    const rMain = await main.evaluate((name) => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<{ ok: boolean; error?: string }> } }).graphyDesktop.assistantViewerCmd("x", { kind: "pluginTool", name, params: { n: 1 } }), `${P}echo_size`);
    check(rMain.ok === false && rMain.error === "forbidden", "🔴 メイン窓からの中継は forbidden", rMain);
    const sMain = await main.evaluate(() => (window as unknown as { graphyDesktop: { assistantPluginToolsSet: (id: string, on: boolean) => Promise<{ ok: boolean; error?: string }> } }).graphyDesktop.assistantPluginToolsSet("ai-tools-demo", false));
    check(sMain.ok === false && sMain.error === "forbidden", "🔴 メイン窓からのオン/オフ変更は forbidden", sMain);

    // --- 9(実行順は 8 の前). write ---
    console.log("\n[9] write のツール");
    const annCount = () => viewer.evaluate(`(function(){ return window.__graphyDebug.getAnnotationCanvasPoints().length; })()`) as Promise<number>;
    const dlW0 = await dlgCount();
    // 前提: ROI が無い間は、承認しても no-roi（操作が効く対象がまだ無い）
    check((await annCount()) === 0, "前提: ROI が 0 件から始まる");
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.getByRole("button", { name: /^(楕円 ROI|Ellipse ROI)$/ }).first().click();
    await viewer.waitForTimeout(250);
    const box = await viewer.getByTestId("series-viewer-root").first().boundingBox();
    if (!box) throw new Error("viewer box");
    await viewer.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
    await viewer.mouse.down();
    await viewer.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 10 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(1500);
    check((await annCount()) === 1, "前提: 楕円 ROI が 1 件描けた", await annCount());
    const readTag = async () => {
      await ask("CALLREAD 読む");
      const r = JSON.parse(lastToolMsg());
      return r?.ok === true && r.data && "tag" in r.data ? (r.data.tag as string | null) : "<read-failed>";
    };
    const dlBeforeRead = await dlgCount();
    check((await readTag()) === null, "前提: 読む側のツールで、タグはまだ無い（null）", lastToolMsg());
    check((await dlgCount()) === dlBeforeRead, "対照: read のツールは確認が出ない");
    // 拒否
    await setResponse(1);
    const tagCalls0 = ((await demo())?.calls ?? []).filter((c) => c.tool === "tag_roi").length;
    await ask("CALLTAG 書く");
    check((await dlgCount()) === dlBeforeRead + 1, "🔴 write は確認が 1 回出る", await dlgCount());
    check(JSON.parse(lastToolMsg()).error === "declined", "🔴 拒否すると declined がモデルへ返る", lastToolMsg());
    check(((await demo())?.calls ?? []).filter((c) => c.tool === "tag_roi").length === tagCalls0, "🔴 拒否したらプラグインの関数は呼ばれない");
    check((await readTag()) === null, "🔴 拒否したら ROI の属性は変わらない（前提: 読み取りは効いている）", lastToolMsg());
    const last = await dlgLast();
    check(/AI Tools Demo/.test(last?.message ?? "") && /tag_roi/.test(last?.message ?? "") && /データを変更/.test(last?.message ?? ""), "確認の主語は main が持つ（プラグイン名・ツール名・データを変更）", last?.message);
    check(/プラグインの記述/.test(last?.detail ?? "") && /"tag":"AI1"/.test(last?.detail ?? ""), "説明は「プラグインの記述」として引用され、引数が出る", last?.detail);
    check(last?.defaultId === 1 && last?.buttons?.[1] === "取り消す", "既定のボタンは「取り消す」", { d: last?.defaultId, b: last?.buttons });
    // 承認
    await setResponse(0);
    const dlBeforeOk = await dlgCount();
    await ask("CALLTAG 書く");
    check((await dlgCount()) === dlBeforeOk + 1, "承認の呼び出しでも確認が 1 回出る");
    check(JSON.parse(lastToolMsg()).ok === true && JSON.parse(lastToolMsg()).data?.ok === true, "承認すると関数が動き、結果が返る", lastToolMsg());
    check((await readTag()) === "AI1", "🔴 承認したらタグが書き込まれている（別の読み取りで確認）", lastToolMsg());
    // 2 回目も確認が出る
    const dlBefore2 = await dlgCount();
    await ask("CALLSECOND もう一度");
    check((await dlgCount()) === dlBefore2 + 1, "🔴 同じツールの 2 回目でも確認が出る（記憶しない）");
    check((await readTag()) === "AI2", "2 回目の承認も反映される", lastToolMsg());
    // 偽装 IPC: approved:true を付けても、確認が拒否されれば動かない
    await setResponse(1);
    const tagCalls1 = ((await demo())?.calls ?? []).filter((c) => c.tool === "tag_roi").length;
    const dlBeforeForge = await dlgCount();
    const forgedW = await cmd({ kind: "pluginTool", name: `${P}tag_roi`, params: { tag: "FORGED" }, approved: true });
    check(forgedW.ok === false && forgedW.error === "declined" && (await dlgCount()) === dlBeforeForge + 1, "🔴 IPC に approved:true を偽っても、確認が出て拒否されれば declined", forgedW);
    check(((await demo())?.calls ?? []).filter((c) => c.tool === "tag_roi").length === tagCalls1 && (await readTag()) === "AI2", "🔴 偽装のあとも関数は呼ばれず、タグも変わらない");
    check((await annCount()) === 1, "ROI の件数は変わらない");
    await win.screenshot({ path: path.join(OUT_DIR, "4-write-done.png") });
    const dlAfterWrite = await dlgCount();
    void dlW0;

    // --- 8. オフに戻す ---
    console.log("\n[8] オフに戻す");
    await win.getByTestId("assistant-plugintools-toggle-ai-tools-demo").click();
    await sleep(800);
    const c8 = ((await demo())?.calls?.length ?? 0);
    const s8 = seen.length;
    await ask("CALLECHO もう一度");
    check(seen.slice(s8).every((r) => !r.tools.some((n) => n.startsWith("plugin__"))) && ((await demo())?.calls?.length ?? 0) === c8, "🔴 オフに戻すと tools に載らず、呼ばれても動かない");
    const rOff = await cmd({ kind: "pluginTool", name: `${P}echo_size`, params: { n: 1 } });
    check(rOff.ok === false && rOff.error === "unknown-tool", "🔴 オフのプラグインは IPC で直接呼んでも unknown-tool", rOff);
    check((await dlgCount()) === dlAfterWrite, "write 以外ではダイアログが出なかった（外部宛の結果送信の承認は単体テストのみ・未達）");
  } finally {
    // スタブを元に戻す（後続の検査に残さない）
    await driver.app
      .evaluate(({ dialog }) => {
        const g = globalThis as unknown as { __dlg?: { orig: unknown } };
        if (g.__dlg) (dialog as unknown as { showMessageBox: unknown }).showMessageBox = g.__dlg.orig;
      })
      .catch(() => undefined);
    await driver.stop();
    fake.close();
    clean();
    removePlugins();
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

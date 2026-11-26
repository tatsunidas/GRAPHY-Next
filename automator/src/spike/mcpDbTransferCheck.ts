/*
 * MCP からの検査のコピーと荷物の取り込みを、実際の中継（desktop/mcpCli.js・stdio）で通す。
 * 起動済みの backend（DT_HTTP）と Vite（DT_VITE）に Electron をつなぐ。
 *   DT_MODE=copy（移し元の DB で実行）| import（空の受け側の DB で実行）
 *   DT_DRIVE=<書き出し先／取り込み元（外付けの役）> DT_OUT=<出力先> DT_SECRET=<GRAPHY_MAIN_SECRET> DT_USERDATA=<専用の userData>
 *   DT_FORBIDDEN=<応答・監査・中継の出力に出てはいけない文字列（カンマ区切り。患者 ID など）>
 * 確認とフォルダ選択のダイアログは main の dialog を差し替えて代行する（本番では利用者が操作する）。出た文面は記録して表示する。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "@playwright/test";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { McpStdio } from "./mcpStdioClient.js";

const HTTP = Number(process.env.DT_HTTP), VITE = Number(process.env.DT_VITE ?? 28752), MODE = process.env.DT_MODE ?? "copy";
const DRIVE = process.env.DT_DRIVE!, OUT = process.env.DT_OUT!, SECRET = process.env.DT_SECRET!, USERDATA = process.env.DT_USERDATA!;
const FORBIDDEN = (process.env.DT_FORBIDDEN ?? "").split(",").filter(Boolean);
const DESKTOP = path.join(path.resolve(AUTOMATOR_ROOT, ".."), "desktop");
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(USERDATA, { recursive: true });
const base = `http://127.0.0.1:${HTTP}`;
const electronPath = createRequire(path.join(DESKTOP, "package.json"))("electron") as unknown as string;
const env = { ...process.env, GRAPHY_DEV: "1", GRAPHY_BACKEND_EXTERNAL: "1", GRAPHY_BACKEND_PORT: String(HTTP), GRAPHY_DEV_SERVER_URL: `http://localhost:${VITE}`, GRAPHY_MAIN_SECRET: SECRET } as Record<string, string>;
delete env.GRAPHY_DEV_DATA_DIR;

let exit = 0;
const check = (ok: boolean, name: string, detail?: unknown) => {
  console.log(`  [${ok ? "ok  " : "NG  "}] ${name}${ok || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 800)}`);
  if (!ok) exit = 1;
};
type Job = { jobId: string; state: string; error?: string; studies?: string[]; files?: number; bytes?: number; plugins?: { id: string; version: string }[]; packages?: { outcome: string; imported: number; failed: number; pluginNotes: unknown[] }[] };
const studies = async () => ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; numberOfInstances: number }[]);
const tree = (d: string): string[] => (fs.existsSync(d) ? (fs.readdirSync(d, { recursive: true }) as string[]) : []);

const app = await electron.launch({ executablePath: electronPath, args: [DESKTOP, `--user-data-dir=${USERDATA}`], cwd: DESKTOP, env });
let mcp: McpStdio | null = null;
const replies: string[] = [];
try {
  let page = app.windows().find((w) => w.url().startsWith(`http://localhost:${VITE}`));
  for (const end = Date.now() + 60_000; !page && Date.now() < end;) { await new Promise((r) => setTimeout(r, 300)); page = app.windows().find((w) => w.url().startsWith(`http://localhost:${VITE}`)); }
  if (!page) throw new Error("メインウィンドウが見つかりません");
  await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  const agree = page.getByRole("button", { name: /Agree and continue|同意して使う/ });
  await agree.waitFor({ state: "visible", timeout: 8000 }).then(() => agree.click()).catch(() => undefined);
  await page.waitForTimeout(3000);
  await dismissStartupDialogs(page);

  // 確認とフォルダ選択の差し替え。__answers の先頭から答える（尽きたら取り消し）。__delay は答えるまでの待ち。
  await app.evaluate(({ dialog }, drive) => {
    const g = globalThis as unknown as { __shown: string[]; __answers: number[]; __delay: number; __folder: string | null; __picked: number };
    g.__shown = []; g.__answers = []; g.__delay = 0; g.__folder = drive; g.__picked = 0;
    const d = dialog as unknown as { showMessageBox: unknown; showOpenDialog: unknown };
    d.showMessageBox = async (...args: unknown[]) => {
      const o = args[args.length - 1] as { title?: string; message?: string; detail?: string; cancelId?: number };
      g.__shown.push(`〔${o.title}〕\n${o.message}\n${o.detail}`);
      await new Promise((r) => setTimeout(r, g.__delay));
      return { response: g.__answers.length ? g.__answers.shift() : (o.cancelId ?? 1) };
    };
    d.showOpenDialog = async () => { g.__picked++; return g.__folder ? { canceled: false, filePaths: [g.__folder] } : { canceled: true, filePaths: [] }; };
  }, DRIVE);
  const answers = (a: number[], delay = 0) => app.evaluate((_e, v) => { const g = globalThis as unknown as { __answers: number[]; __delay: number; __shown: string[] }; g.__answers = [...v.a]; g.__delay = v.delay; g.__shown = []; }, { a, delay });
  const shown = () => app.evaluate(() => (globalThis as unknown as { __shown: string[] }).__shown);
  const picked = () => app.evaluate(() => (globalThis as unknown as { __picked: number }).__picked);
  const setMcp = (patch: Record<string, boolean>) => page!.evaluate((p) => (window as unknown as { graphyDesktop: { setMcp(x: unknown): Promise<{ ok: boolean; error?: string }> } }).graphyDesktop.setMcp(p), patch);

  // 受け口を開く（設定の画面と同じ IPC。オンにする確認は main が出す）
  await answers([0]);
  check((await setMcp({ enabled: true })).ok, "MCP の受け口をオンにできる");
  mcp = McpStdio.fromRepo(path.join(USERDATA, "mcp-endpoint.json"), "db-transfer-check");
  await answers([0]); // 最初の接続の同意
  await mcp.init();
  const names = async () => (((await mcp!.request("tools/list")).result as { tools: { name: string }[] }).tools.map((t) => t.name));
  const T = ["db_copy_submit", "db_import_submit", "db_transfer_status"];
  const before = await names();
  check(before.includes("search_studies") && T.every((n) => !before.includes(n)), "許可の前は、移行のツールが一覧に無い", before);
  const off = await mcp.call("db_import_submit", {});
  replies.push(off.text);
  check(off.isError && /transfer-disabled/.test(off.text), "許可の前に呼ぶと transfer-disabled", off.text);

  await answers([1]);
  check(!(await setMcp({ allowDbTransfer: true })).ok, "許可の確認で「やめる」ならオンにならない");
  await answers([0]);
  check((await setMcp({ allowDbTransfer: true })).ok, "許可の確認で「オンにする」ならオンになる");
  console.log("許可の確認の文面:\n" + (await shown()).join("\n"));
  check((await names()).filter((n) => T.includes(n)).length === 3, "移行のツールが 3 つ出る");

  const call = async (name: string, args: Record<string, unknown> = {}) => { const r = await mcp!.call(name, args); replies.push(r.text); return r; };
  const wait = async (jobId: string) => {
    for (const end = Date.now() + 15 * 60_000; Date.now() < end;) {
      const r = await call("db_transfer_status", { jobId });
      const j = r.json as Job;
      if (!j || !["awaiting-user", "running"].includes(j.state)) return j;
      await new Promise((s) => setTimeout(s, 3000));
    }
    throw new Error("ジョブが終わりません");
  };

  if (MODE === "copy") {
    const found = (await call("search_studies", {})).json as { study: string }[];
    check(found.length === 2 && found.every((s) => /^st_/.test(s.study)), "検査は札で 2 件見える", found);
    const handles = found.map((s) => s.study);

    // 取り消し（確認で断る）。出ている間の 2 件目は busy
    await answers([1], 4000);
    const r1 = (await call("db_copy_submit", { studies: handles })).json as Job;
    check(r1?.state === "awaiting-user", "すぐ jobId が返る", r1);
    const r2 = await call("db_copy_submit", { studies: handles });
    check(r2.isError && /busy/.test(r2.text), "利用者の操作待ちの間の 2 件目は busy", r2.text);
    const j1 = await wait(r1.jobId);
    check(j1.state === "declined", "確認で断ると declined", j1);
    check(tree(DRIVE).length === 0 && (await picked()) === 0, "断ると、フォルダ選択も書き出しも無い");

    // 無応答のかわりに既定の応答（取り消し）
    await answers([]);
    const j2 = await wait(((await call("db_copy_submit", { studies: handles })).json as Job).jobId);
    check(j2.state === "declined" && tree(DRIVE).length === 0, "既定の応答は取り消し", j2);

    const bad = await call("db_copy_submit", { studies: [handles[0], "st_0000000000000000"] });
    check(bad.isError && /unknown-handle/.test(bad.text), "知らない札は拒否", bad.text);
    const move = await call("db_copy_submit", { studies: handles, mode: "move" });
    check(move.isError && /unknown-arg/.test(move.text), "移動の指定は受けない", move.text);

    await answers([0]);
    const ok = (await call("db_copy_submit", { studies: handles })).json as Job;
    const j3 = await wait(ok.jobId);
    console.log("コピーの結果:", JSON.stringify(j3));
    console.log("コピーの確認の文面:\n" + (await shown()).join("\n"));
    check(j3.state === "done" && (j3.files ?? 0) > 0 && j3.studies?.length === 2, "承認するとコピーされる（2 検査）", j3);
    check(!!j3.plugins?.some((p) => p.id === "4dflow" && p.version === "0.6.1"), "プラグインの版が返る", j3.plugins);
    check((await studies()).length === 2, "移し元の検査は残る");
  } else {
    check((await studies()).length === 0, "受け側の DB は空");
    await answers([1]);
    const p0 = await picked();
    const j1 = await wait(((await call("db_import_submit")).json as Job).jobId);
    check(j1.state === "declined" && (await picked()) === p0, "依頼を断ると、フォルダ選択まで進まない", j1);
    await answers([0, 1]);
    const j2 = await wait(((await call("db_import_submit")).json as Job).jobId);
    check(j2.state === "declined" && (await studies()).length === 0, "内容の確認で断ると何も入らない", j2);
    await answers([0, 0]);
    const j3 = await wait(((await call("db_import_submit")).json as Job).jobId);
    console.log("取り込みの結果:", JSON.stringify(j3));
    console.log("取り込みの確認の文面:\n" + (await shown()).join("\n---\n"));
    check(j3.state === "done" && j3.packages?.length === 1 && j3.packages[0].outcome === "imported" && j3.packages[0].failed === 0, "承認すると取り込まれる", j3);
    const now = await studies();
    check(now.length === 2 && j3.studies?.length === 2, "検査が 2 件入り、札が返る", now);
    const series = await call("list_series", { study: j3.studies?.[0] });
    check(!series.isError && Array.isArray(series.json) && (series.json as unknown[]).length > 0, "返った札で続けて検査を調べられる", series.text);
  }

  await page.waitForTimeout(1500);
  const audit = fs.readFileSync(path.join(USERDATA, "mcp-audit.jsonl"), "utf8");
  check(new RegExp(`"event":"db-${MODE}","[^\\n]*"outcome":"done"`).test(audit) || audit.split("\n").some((l) => l.includes(`"db-${MODE}"`) && l.includes('"done"')), "監査に結果が残る", audit.slice(-600));
  const uids = (await studies()).map((s) => s.studyInstanceUid);
  const hay = { replies: replies.join("\n"), audit, stderr: mcp.stderr };
  const hits = Object.entries(hay).flatMap(([k, v]) => [...FORBIDDEN, DRIVE, ...uids].filter((s) => v.includes(s)).map((s) => `${k}:${s}`));
  check(replies.length >= 5 && FORBIDDEN.length > 0 && uids.length === 2 && hits.length === 0, `応答 ${replies.length} 件・監査・中継の出力に、患者の値・フォルダ・生の UID が無い`, hits);
  console.log(exit === 0 ? "ALL OK" : "FAILED CHECKS");
} catch (e) {
  console.error("FAILED", e); exit = 1;
  for (const [i, w] of app.windows().entries()) await w.screenshot({ path: path.join(OUT, `failed-${i}.png`) }).catch(() => undefined);
} finally { mcp?.close(); await app.close().catch(() => undefined); }
process.exit(exit);

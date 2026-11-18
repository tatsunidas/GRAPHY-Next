/*
 * インストール版の MCP の中継 `resources/cli/graphy-mcp(.cmd)` の起動検査（installedSmoke.ts の節。実機の開発ツリーでも同じ関数を
 * spike/mcpSectionLocal.ts から通して確かめてある）。設計: roadmap fw/mcp-server-design.md §9 の合格条件
 * 「配布物（Windows・macOS の実ランナー）で起動して get_status が通る」。
 *
 *   前準備: アプリの起動**前**に userData/mcp.json を置く（seedMcpPrefs）。起動時に enabled が効いて受け口が待ち受ける。
 *   running: 発見用ファイルが既定の場所にある → 同意を許可して接続 → 一覧・get_status → 患者情報（オン→出る／オフ→0 件）→ 拒否した別の接続。
 *   closed : アプリを閉じた後は「起動していないか MCP がオフ」と返す（中継は落ちない）。
 *
 * 🔴 `GRAPHY_MCP_ENDPOINT` は渡さない（既定の場所が OS ごとに main と一致するかが検査の目的）。Windows は main が既知の Roaming を使うので、
 *    環境変数 APPDATA の差し替えを外した環境で中継を動かす（呼び出し側が渡す env）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication } from "@playwright/test";

import { McpStdio } from "../spike/mcpStdioClient.js";
import { tinyDicomIds, writeTinyDicom } from "./tinyDicom.js";

export interface McpSmokeCtx {
  app: ElectronApplication;
  /** `<install>/resources`（`cli/graphy-mcp(.cmd)` がある）。 */
  resources: string;
  /** 中継に渡す環境変数（`GRAPHY_MCP_ENDPOINT` は入れない）。 */
  env: Record<string, string>;
  /** アプリの userData（mcp.json・mcp-endpoint.json・mcp-audit.jsonl がある）。 */
  userData: string;
  apiBase: string;
  workDir: string;
  outDir: string;
  check: (cond: boolean, label: string, detail?: unknown) => void;
  info: (msg: string) => void;
}

/**
 * アプリの userData の想定。Electron の規則（package.json の productName、無ければ name。今は name=graphy-next-desktop）で、
 * データ（DB・設定）の appData/GRAPHY-Next とは**別のフォルダ**（2026-11-17 の予行演習で判明）。想定が実際と合っているかは、起動後に
 * app.getPath("userData") と突き合わせて検査する。Linux はプロファイルを XDG_CONFIG_HOME に向けた前提。
 */
export function userDataFor(profile: string): string {
  const base =
    process.platform === "win32" ? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
    : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support")
    : profile;
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "..", "desktop", "package.json"), "utf8")) as { name: string; productName?: string };
  return path.join(base, pkg.productName || pkg.name);
}

/** 実プロファイルを触ってよいのは、Linux（プロファイルを隔離してある）と CI だけ。 */
export const canSeedMcp = (): boolean => process.platform === "linux" || process.env.CI === "true";

export function seedMcpPrefs(userData: string, p: { enabled: boolean; includePhi: boolean; allowAnalysis: boolean }): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, "mcp.json"), JSON.stringify(p));
}

function relay(ctx: McpSmokeCtx, clientName: string): McpStdio {
  const wrapper = path.join(ctx.resources, "cli", process.platform === "win32" ? "graphy-mcp.cmd" : "graphy-mcp");
  const env: Record<string, string | undefined> = { ...ctx.env };
  delete env.GRAPHY_MCP_ENDPOINT;
  return process.platform === "win32"
    ? new McpStdio({ command: `"${wrapper}"`, args: [], env, clientName, shell: true })
    : new McpStdio({ command: wrapper, args: [], env, clientName });
}

/** 同意ダイアログ（dialog.showMessageBox）を許可／拒否に差し替える。アプリは変えない。復元は restoreDialog。 */
async function stubDialog(app: ElectronApplication, response: 0 | 1): Promise<void> {
  await app.evaluate(({ dialog }, r) => {
    const g = globalThis as unknown as { __mcpOrigBox?: unknown };
    if (!g.__mcpOrigBox) g.__mcpOrigBox = dialog.showMessageBox;
    (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: r, checkboxChecked: false });
  }, response);
}
async function restoreDialog(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __mcpOrigBox?: typeof dialog.showMessageBox };
    if (g.__mcpOrigBox) (dialog as unknown as { showMessageBox: unknown }).showMessageBox = g.__mcpOrigBox;
  });
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const names = async (m: McpStdio): Promise<string[]> => (((await m.request("tools/list")).result as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name);

export async function mcpSection(ctx: McpSmokeCtx, phase: "running" | "closed"): Promise<void> {
  const { check } = ctx;
  const logFile = path.join(ctx.outDir, "mcp-output.log");
  const log = (s: string) => fs.appendFileSync(logFile, `${s}\n`);

  if (phase === "closed") {
    // アプリを閉じた後。発見用ファイルが消えている → 中継は落ちず、分かる文面を返す
    const m = relay(ctx, "claude-smoke-closed");
    try {
      await m.init();
      const r = await m.call("get_status");
      log(`closed: isError=${r.isError} ${r.text}`);
      check(r.isError && /起動していない/.test(r.text), "[14] ★アプリを閉じた後の graphy-mcp は「起動していないか MCP がオフ」と返す（中継は落ちない）", { isError: r.isError, text: r.text.slice(0, 120) });
      check(!fs.existsSync(path.join(ctx.userData, "mcp-endpoint.json")), "[14] アプリの終了で発見用ファイルが消える");
    } catch (e) {
      check(false, "[14] アプリを閉じた後の graphy-mcp が応答する", String(e).slice(0, 200));
    } finally {
      m.close();
    }
    return;
  }

  // ── running ──
  // 前準備で mcp.json を置いた場所が、実際のアプリの userData と同じか（違えば起動時に enabled が効かない）
  const actual = await ctx.app.evaluate(({ app }) => app.getPath("userData"));
  const norm = (p: string) => path.resolve(p).toLowerCase();
  check(norm(actual) === norm(ctx.userData), "[14] ★アプリの userData が、mcp.json を置いた場所（想定）と同じ（データの GRAPHY-Next とは別のフォルダ）", { actual: actual.replace(os.homedir(), "<home>"), expected: ctx.userData.replace(os.homedir(), "<home>") });
  const endpoint = path.join(ctx.userData, "mcp-endpoint.json");
  const up = await waitFor(() => fs.existsSync(endpoint), 30_000);
  check(up, "[14] ★アプリの起動時に mcp.json の enabled が効き、発見用ファイル（mcp-endpoint.json）が userData にできる", { userData: ctx.userData.replace(os.homedir(), "<home>") });
  if (!up) return;

  // 患者の値が入った検査を 1 件取り込む（真値は backend の応答から取る＝MCP を通さない）
  const dcm = path.join(ctx.workDir, "mcp-tiny.dcm");
  const ids = tinyDicomIds(Date.now() % 2_000_000_000);
  const patient = { patientName: "SMOKE^PATIENT", patientId: "SMK12345", studyDate: "20260115", accessionNumber: "ACC778899" };
  writeTinyDicom(dcm, { ...patient, ...ids });
  const imp = await fetch(`${ctx.apiBase}/api/import/paths`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: [dcm] }) })
    .then((r) => r.json() as Promise<{ imported?: number }>)
    .catch(() => ({ imported: 0 }));
  check(imp.imported === 1, "[14] 患者情報入りの検査を 1 件取り込めた", imp);
  const status = (await fetch(`${ctx.apiBase}/api/status`).then((r) => r.json())) as { version: string };
  const truth = [patient.patientName, patient.patientId, patient.accessionNumber, ids.studyUid, ids.seriesUid, ids.sopUid];

  await stubDialog(ctx.app, 0);
  const m = relay(ctx, "claude-smoke-allow");
  try {
    await m.init();
    const tools = await names(m);
    log(`tools: ${tools.join(",")}`);
    check(tools.includes("get_status") && tools.includes("search_studies"), "[14] ★graphy-mcp から tools/list が取れる（get_status・search_studies がある）", tools);
    check(!tools.includes("radiomics_submit"), "[14] 解析のツールは、既定（解析の許可がオフ）では出ない");
    check(!tools.includes("capture_viewer_image"), "[14] 画像（画素）を返すツールは、既定（画像を返す許可がオフ）では出ない", tools.filter((n) => /capture/.test(n)));
    check(!tools.some((n) => n.startsWith("plugin__")), "[14] プラグインのツールは、既定（公開するプラグインが空）では出ない", tools.filter((n) => n.startsWith("plugin__")));
    check(!["create_roi", "create_contour_roi", "clear_measurements"].some((n) => tools.includes(n)), "[14] ROI の作成・計測の全削除のツールは、既定（データを変える許可がオフ）では出ない", tools.filter((t) => /roi|clear/.test(t)));
    check(!tools.includes("set_window_level") && !tools.includes("undo_viewer_action") && tools.includes("get_viewer_state"), "[14] 2D ビューアの表示操作のツールは、既定（表示操作の許可がオフ）では出ない（読み取りは出る）", tools.filter((t) => /window|slice|layout|rotate|flip|invert|tool|undo/.test(t)));
    const st = await m.call("get_status");
    log(`get_status: ${st.text}`);
    check(!st.isError && (st.json as { version?: string } | null)?.version === status.version, "[14] ★get_status が通り、版が /api/status と同じ", { mcp: st.text.slice(0, 120), api: status.version });

    // 患者情報: 先にオンで出ることを確かめる（検査が空振りでない証拠）→ オフで 0 件
    seedMcpPrefs(ctx.userData, { enabled: true, includePhi: true, allowAnalysis: false });
    const on = await m.call("search_studies", { limit: 5 });
    check(on.text.includes(patient.patientName) && on.text.includes(patient.patientId), "[14] 患者情報オンでは、患者名・患者 ID が返る（先に確かめる）");
    seedMcpPrefs(ctx.userData, { enabled: true, includePhi: false, allowAnalysis: false });
    const off = await m.call("search_studies", { limit: 5 });
    const handle = (off.json as { study?: string }[] | null)?.[0]?.study ?? "";
    const series = await m.call("list_series", { study: handle });
    const all = [off.text, series.text].join("\n");
    log(`off: ${all.replace(/\s+/g, " ").slice(0, 300)}`);
    check(/^st_/.test(handle) && truth.every((v) => !all.includes(v)), "[14] ★患者情報オフでは、検査・シリーズの出力に患者名・ID・受付番号・UID が 0 件（札が返る）", { handle: handle.slice(0, 8) });
    const audit = fs.existsSync(path.join(ctx.userData, "mcp-audit.jsonl")) ? fs.readFileSync(path.join(ctx.userData, "mcp-audit.jsonl"), "utf8") : "";
    check(audit.length > 0 && truth.every((v) => !audit.includes(v)), "[14] 監査ログができていて、患者の値が 0 件", { bytes: audit.length });
    check(truth.every((v) => !m.stderr.includes(v)), "[14] 中継の stderr に患者の値が 0 件");
  } catch (e) {
    check(false, "[14] graphy-mcp の検査が完走した", String(e).slice(0, 300));
  } finally {
    m.close();
  }

  // 負例: 拒否した接続は受け付けない（別の自称名。起動中は同じ名前の拒否が続く）
  await stubDialog(ctx.app, 1);
  const d = relay(ctx, "claude-smoke-deny");
  try {
    await d.init();
    const r = await d.call("get_status");
    log(`denied: ${r.text}`);
    check(r.isError && /拒否/.test(r.text), "[14] 拒否した接続は受け付けず、拒否の文面を返す（負例）", { text: r.text.slice(0, 100) });
  } catch (e) {
    check(false, "[14] 拒否の経路が応答する", String(e).slice(0, 200));
  } finally {
    d.close();
    await restoreDialog(ctx.app);
  }
}

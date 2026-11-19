/* 実クライアント（Claude Code）から capture_viewer_image を呼び、返った画像をモデルが見られるかの 1 往復の検査。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { spawnSync } from "node:child_process";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "mcp-realclient");
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

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const userData = path.join(OUT_DIR, "userdata");
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(userData, { recursive: true });
  const prefs = (capture: boolean) => fs.writeFileSync(path.join(userData, "mcp.json"), JSON.stringify({ enabled: true, includePhi: false, allowAnalysis: false, allowViewerControl: true, allowViewerEdit: true, allowViewerCapture: capture, pluginTools: [] }));
  prefs(true);

  const d = new DesktopDriver({}, { extraElectronArgs: [`--user-data-dir=${userData}`] });
  try {
    await d.start();
    const base = `http://127.0.0.1:${d.ports.http}`;
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
      const g = globalThis as unknown as { __dlg?: unknown; __orig?: unknown };
      g.__orig = dialog.showMessageBox;
      const st = { log: [] as { title: string; message: string; detail: string; hasIcon: boolean; iconW: number }[], mode: "accept" };
      g.__dlg = st;
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (...a: unknown[]) => {
        const o = (a.length > 1 ? a[1] : a[0]) as { title: string; message: string; detail: string; buttons: string[]; cancelId?: number; icon?: { getSize?: () => { width: number } } };
        st.log.push({ title: o.title, message: o.message, detail: o.detail, hasIcon: !!o.icon, iconW: o.icon?.getSize?.().width ?? 0 });
        return { response: st.mode === "accept" ? 0 : (o.cancelId ?? o.buttons.length - 1), checkboxChecked: false };
      };
    });
    type Dlg = { log: { title: string; message: string; detail: string; hasIcon: boolean; iconW: number }[]; mode: string };
    const dlg = (): Promise<{ log: { message: string; hasIcon: boolean }[] }> => d.app.evaluate(() => (globalThis as unknown as { __dlg: { log: { message: string; hasIcon: boolean }[] } }).__dlg);
    const cfg = path.join(OUT_DIR, "mcp-config.json");
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { graphy: { command: process.execPath, args: [path.join(AUTOMATOR_ROOT, "..", "desktop", "mcpCli.js")], env: { GRAPHY_MCP_ENDPOINT: endpoint } } } }));
    const r = spawnSync("claude", ["-p", "--model", "sonnet", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", cfg, "--allowedTools", "mcp__graphy__capture_viewer_image", "--tools", "",
      "--output-format", "json", "--no-session-persistence",
      "graphy の capture_viewer_image を withRoi なしで 1 回呼び、返ってきた画像に何が写っているかを日本語で 2 文で説明してください。画像が受け取れなかった場合は、その旨とエラー内容をそのまま書いてください。"],
      { encoding: "utf8", timeout: 240_000 });
    fs.writeFileSync(path.join(OUT_DIR, "claude-out.json"), r.stdout ?? "");
    console.log("exit", r.status, (r.stderr ?? "").slice(0, 500));
    const j = JSON.parse(r.stdout || "{}") as { result?: string; is_error?: boolean };
    console.log("CLAUDE:", j.result);
    const asks = (await dlg()).log.filter((x) => /表示中の画像/.test(x.message));
    check(asks.length === 1 && asks[0].hasIcon, "実クライアントの呼び出しで確認が 1 回（サムネイルつき）出た", asks.length);
    check(!j.is_error && !!j.result, "claude -p が正常終了した");
  } finally {
    await d.stop().catch(() => undefined);
  }
  console.log(`\n${passed} ok, ${failures.length} fail`);
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

/*
 * installedSmoke.ts の MCP の節（src/smoke/mcpSection.ts）を、**開発ツリーで**先に通す確認用スパイク。
 * インストール版の配置（resources/cli/graphy-mcp・../graphy-next-desktop・resources/app.asar/mcpCli.js）を、開発ツリーの desktop から
 * 作り（app.asar はフォルダで代用）、開発起動の Electron を `--user-data-dir=<XDG_CONFIG_HOME>/GRAPHY-Next` で動かして、
 * 中継の既定の発見用ファイルの場所（XDG_CONFIG_HOME/GRAPHY-Next）を製品版と同じ規則で解決させる。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=19540 GRAPHY_AUTOMATOR_SCP_PORT=19541 GRAPHY_AUTOMATOR_VITE_PORT=19543 \
 *          npx tsx src/spike/mcpSectionLocal.ts       （Linux 専用。実際の配布物の検査は release.yml の installedSmoke）
 *          MCP_LOCAL_NEG=1 を付けると負例（userData の名前を変える）。
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { mcpSection, seedMcpPrefs } from "../smoke/mcpSection.js";

const REPO = path.join(AUTOMATOR_ROOT, "..");
const WORK = path.join(AUTOMATOR_ROOT, ".results", "mcp-section-local");
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
  if (process.platform !== "linux") throw new Error("Linux 専用");
  fs.rmSync(WORK, { recursive: true, force: true });
  const inst = path.join(WORK, "install");
  const asar = path.join(inst, "resources", "app.asar");
  fs.mkdirSync(asar, { recursive: true });
  fs.mkdirSync(path.join(inst, "resources", "cli"), { recursive: true });
  const desktop = path.join(REPO, "desktop");
  for (const f of fs.readdirSync(desktop)) if (/\.(js|json)$/.test(f) && f !== "package-lock.json") fs.copyFileSync(path.join(desktop, f), path.join(asar, f));
  fs.cpSync(path.join(desktop, "mcp"), path.join(asar, "mcp"), { recursive: true });
  fs.cpSync(path.join(desktop, "aiAdapters"), path.join(asar, "aiAdapters"), { recursive: true });
  fs.copyFileSync(path.join(desktop, "cli", "graphy-mcp"), path.join(inst, "resources", "cli", "graphy-mcp"));
  fs.chmodSync(path.join(inst, "resources", "cli", "graphy-mcp"), 0o755);
  const electron = path.join(desktop, "node_modules", "electron", "dist", "electron");
  fs.writeFileSync(path.join(inst, "graphy-next-desktop"), `#!/bin/sh\nexec "${electron}" "$@"\n`, { mode: 0o755 });

  const xdg = path.join(WORK, "profile");
  // MCP_LOCAL_NEG=1: アプリの userData を製品版と違う名前にする（負例: 中継の既定の場所と食い違うと、節が落ちること）
  const userData = path.join(xdg, process.env.MCP_LOCAL_NEG === "1" ? "graphy-next-desktop" : "GRAPHY-Next");
  seedMcpPrefs(userData, { enabled: true, includePhi: false, allowAnalysis: false });
  const d = new DesktopDriver({}, { extraElectronArgs: [`--user-data-dir=${userData}`] });
  await d.start();
  const ctx = {
    app: d.app,
    resources: path.join(inst, "resources"),
    env: { ...(process.env as Record<string, string>), XDG_CONFIG_HOME: xdg },
    userData,
    apiBase: `http://127.0.0.1:${d.ports.http}`,
    workDir: WORK,
    outDir: WORK,
    check,
    info: (m: string) => console.log(`  [情報] ${m}`),
  };
  try {
    await resetDb(d.ports.http);
    console.log("[running]");
    await mcpSection(ctx, "running");
  } finally {
    await d.stop();
  }
  console.log("[closed]");
  await mcpSection(ctx, "closed");
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

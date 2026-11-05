/*
 * 起動（スプラッシュ → メイン画面の表示）にかかる時間の測定。ネットワークの状態を変えて比べるための道具で、
 * 合否は付けない（時間を記録して表にする）。製品と同じく **main が backend を spawn する**経路で測る
 * （DesktopDriver は backend を別起動するので、ここでは使わない）。
 *
 * 実行（`automator/scripts/offline-startup.sh` から呼ぶ。名前空間の中で動かす前提）:
 *   npx tsx src/spike/offlineStartupProbe.ts <label> <outDir>
 *
 * 記録: スプラッシュが見えた時刻・メイン画面が見えた時刻（Electron 起動の直前を 0 とする）、main の標準出力の各行の時刻。
 * 前提: backend/target/graphy-next-backend.jar と frontend の node_modules。Vite の dev サーバーは自分で起動する
 *       （その起動時間は測定に含めない）。専用ポートは環境変数 PROBE_HTTP / PROBE_VITE で変えられる。
 */
import { _electron as electron } from "@playwright/test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { killProcessTree } from "../common/processUtils.js";
import { waitForHttp } from "../common/waitForHttp.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const ROOT = path.resolve(AUTOMATOR_ROOT, "..");
const DESKTOP_DIR = path.join(ROOT, "desktop");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const HTTP = Number(process.env.PROBE_HTTP ?? 18720);
const VITE = Number(process.env.PROBE_VITE ?? 18723);

const label = process.argv[2] ?? "probe";
const outDir = process.argv[3] ?? path.join(AUTOMATOR_ROOT, ".results", "offline-startup", label);
const dataDir = process.env.PROBE_DATA_DIR ?? path.join(AUTOMATOR_ROOT, ".results", "offline-startup", "data");

async function main(): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const vite = spawn("npm", ["run", "dev", "--", "--port", String(VITE), "--strictPort"], {
    cwd: FRONTEND_DIR, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  vite.stdout?.on("data", () => {});
  vite.stderr?.on("data", () => {});
  try {
    await waitForHttp({ host: "localhost", port: VITE, path: "/", timeoutMs: 60_000 });
    // dev サーバーの最初の取得（変換）を済ませ、測定にその時間が混ざらないようにする
    await fetch(`http://localhost:${VITE}/`).then((r) => r.text()).catch(() => "");
    await fetch(`http://localhost:${VITE}/src/main.tsx`).then((r) => r.text()).catch(() => "");

    const requireFromDesktop = createRequire(path.join(DESKTOP_DIR, "package.json"));
    const electronPath = requireFromDesktop("electron") as unknown as string;
    const env: Record<string, string | undefined> = {
      ...process.env,
      GRAPHY_DEV: "1",
      GRAPHY_BACKEND_PORT: String(HTTP),
      GRAPHY_DEV_SERVER_URL: `http://localhost:${VITE}`,
      GRAPHY_DEV_DATA_DIR: dataDir,
    };
    delete env.GRAPHY_BACKEND_EXTERNAL;

    const lines: string[] = [];
    const t0 = Date.now();
    const rel = () => ((Date.now() - t0) / 1000).toFixed(2);
    const app = await electron.launch({ executablePath: electronPath, args: [DESKTOP_DIR], cwd: DESKTOP_DIR, env: env as Record<string, string> });
    const launched = rel();
    const onData = (buf: Buffer) => {
      for (const l of buf.toString("utf8").split(/\r?\n/)) if (l.trim()) lines.push(`${rel()}s ${l}`);
    };
    app.process().stdout?.on("data", onData);
    app.process().stderr?.on("data", onData);

    let splashAt: string | null = null;
    let mainAt: string | null = null;
    const deadline = Date.now() + 170_000;
    while (Date.now() < deadline && !mainAt) {
      const wins = (await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w: { webContents: { getURL(): string }; isVisible(): boolean }) => ({ url: w.webContents.getURL(), visible: w.isVisible() })),
      ).catch(() => [])) as { url: string; visible: boolean }[];
      if (!splashAt && wins.some((w) => /splash\.html/.test(w.url) && w.visible)) splashAt = rel();
      if (wins.some((w) => w.url.startsWith(`http://localhost:${VITE}`) && w.visible)) mainAt = rel();
      await new Promise((r) => setTimeout(r, 100));
    }
    const result = { label, electronLaunched: launched, splashVisible: splashAt, mainVisible: mainAt, timedOut: !mainAt };
    fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(outDir, "main-stdout.txt"), lines.join("\n"));
    console.log(JSON.stringify(result));
    await app.close().catch(() => {});
  } finally {
    killProcessTree(vite);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

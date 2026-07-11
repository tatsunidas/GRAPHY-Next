// スパイク: Playwright の _electron が desktop/main.js を実際に起動でき、
// firstWindow() が有効な Page を返すかどうかを確認する。driver/desktopDriver.ts の実装前に
// 単体で検証する使い捨てスクリプト（automator/README.md の "npx tsx src/spike/electronLaunch.ts" から実行）。
//
// 実行中の本物の backend(:8080) とはポートを分け、GRAPHY_BACKEND_EXTERNAL=1 で自前 spawn をスキップし、
// スパイク専用の backend プロセス(別ポート/別データディレクトリ)を automator 側から明示的に起動する。
import { _electron as electron } from "playwright";
import { createRequire } from "node:module";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

// npm.cmd 経由で spawn した子(vite)は、cmd.exe → npm → node の多段プロセスツリーになるため、
// proc.kill() では中間の cmd.exe しか終わらず、実体の node プロセスがポートを握ったまま孤児化する
// （このスパイクの開発中に実際に踏んだ罠: 5173 に孤児 Vite が残り続けた）。
// Windows では常に taskkill /T(ツリー) /F で確実に子孫ごと終了させる。proc.pid は自分で spawn した
// プロセスの pid なので、他セッションのプロセスを誤って巻き込む心配はない。
function killProcessTree(proc: ChildProcess) {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    proc.kill();
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const DESKTOP_DIR = path.join(ROOT, "desktop");
const BACKEND_JAR = path.join(ROOT, "backend", "target", "graphy-next-backend.jar");
const SPIKE_DATA_DIR = path.join(ROOT, "automator", ".results", "spike-electron-data");
// 実行中の他インスタンス（本物の dev backend 等）と衝突しないよう、HTTP/SCP とも専用ポートに固定する。
// SCP ポートは application-standalone.yml で 11112 固定のため、明示的に上書きしないと複数インスタンスを
// 同時起動できない（デバッグ中に発覚した罠）。
const SPIKE_HTTP_PORT = 18083;
const SPIKE_SCP_PORT = 18084;

function waitForHttp(host: string, port: string | number, pathName: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  const elapsed = () => Date.now() - start;
  let attempt = 0;
  return new Promise((resolve, reject) => {
    const retry = (reason: string) => {
      console.log(`[spike]   attempt ${attempt} (${elapsed()}ms): retry (${reason})`);
      if (elapsed() > timeoutMs) {
        reject(new Error(`timeout waiting for http://${host}:${port}${pathName} after ${attempt} attempts`));
        return;
      }
      setTimeout(tick, 500);
    };
    const tick = () => {
      attempt += 1;
      const req = http.get({ host, port, path: pathName, timeout: 4000 }, (res) => {
        res.resume();
        console.log(`[spike]   attempt ${attempt} (${elapsed()}ms): status=${res.statusCode}`);
        if (res.statusCode && res.statusCode < 500) {
          resolve();
          return;
        }
        retry(`status=${res.statusCode}`);
      });
      req.on("error", (err) => retry(`error=${(err as Error).message}`));
      req.on("timeout", () => req.destroy(new Error("request-timeout")));
    };
    tick();
  });
}

async function main() {
  if (!fs.existsSync(BACKEND_JAR)) {
    throw new Error(`backend jar が見つかりません: ${BACKEND_JAR}\n先に "cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package" を実行してください。`);
  }
  fs.mkdirSync(SPIKE_DATA_DIR, { recursive: true });

  console.log(`[spike] starting scratch backend on :${SPIKE_HTTP_PORT} (scp:${SPIKE_SCP_PORT}, cwd=${SPIKE_DATA_DIR})`);
  const backendProc: ChildProcess = spawn(
    "java",
    [
      "-jar", BACKEND_JAR,
      "--spring.profiles.active=standalone",
      `--server.port=${SPIKE_HTTP_PORT}`,
      `--graphy.dicom.scp.port=${SPIKE_SCP_PORT}`,
    ],
    { cwd: SPIKE_DATA_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );
  backendProc.stdout?.on("data", (d) => process.stdout.write(`[backend] ${d}`));
  backendProc.stderr?.on("data", (d) => process.stderr.write(`[backend] ${d}`));

  let electronApp: Awaited<ReturnType<typeof electron.launch>> | null = null;
  try {
    console.log("[spike] waiting for scratch backend health check...");
    await waitForHttp("127.0.0.1", SPIKE_HTTP_PORT, "/api/status", 60_000);
    console.log("[spike] scratch backend healthy.");

    console.log("[spike] starting Vite dev server on :5173 (frontend/)...");
    const viteProc: ChildProcess = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "dev"],
      { cwd: path.join(ROOT, "frontend"), stdio: ["ignore", "pipe", "pipe"] },
    );
    viteProc.stdout?.on("data", (d) => process.stdout.write(`[vite] ${d}`));
    viteProc.stderr?.on("data", (d) => process.stderr.write(`[vite] ${d}`));
    try {
      // Vite dev server は既定で localhost(→ このマシンでは ::1 優先) にバインドされ、127.0.0.1 では
      // 繋がらないことがある（開発中に実際に踏んだ罠）。desktop/config.json の devServerUrl と同じ
      // "localhost" ホスト名で待ち受け確認する。
      await waitForHttp("localhost", 5173, "/", 60_000);
      console.log("[spike] Vite ready.");

      const requireFromDesktop = createRequire(path.join(DESKTOP_DIR, "package.json"));
      const electronPath = requireFromDesktop("electron") as unknown as string;
      console.log(`[spike] electron executable: ${electronPath}`);

      console.log("[spike] launching Electron via playwright._electron ...");
      electronApp = await electron.launch({
        executablePath: electronPath,
        args: [DESKTOP_DIR],
        cwd: DESKTOP_DIR,
        env: {
          ...process.env,
          GRAPHY_DEV: "1",
          GRAPHY_BACKEND_EXTERNAL: "1",
          GRAPHY_BACKEND_PORT: String(SPIKE_HTTP_PORT),
        },
      });

      const win = await electronApp.firstWindow();
      console.log(`[spike] firstWindow() resolved. title="${await win.title()}" url=${win.url()}`);

      // スプラッシュはメインウィンドウの ready-to-show で自動的に閉じる想定。
      // ここではメインウィンドウ(devServerUrl をロードしたもの)を明示的に待つ。
      const mainWin = await electronApp.waitForEvent("window", {
        predicate: (w) => w.url().startsWith("http://localhost:5173"),
        timeout: 30_000,
      }).catch(() => win); // 既に firstWindow が本体なら fallback

      await mainWin.waitForLoadState("domcontentloaded");
      console.log(`[spike] main window ready. title="${await mainWin.title()}" url=${mainWin.url()}`);
      const bodyText = await mainWin.evaluate(() => document.body?.innerText?.slice(0, 200) ?? "");
      console.log(`[spike] body text (先頭200文字): ${JSON.stringify(bodyText)}`);

      console.log("[spike] SUCCESS: Playwright _electron が desktop/main.js を起動し、Page を取得できました。");
    } finally {
      killProcessTree(viteProc);
    }
  } finally {
    if (electronApp) await electronApp.close().catch(() => {});
    killProcessTree(backendProc);
  }
}

main().catch((e) => {
  console.error("[spike] FAILED:", e);
  process.exitCode = 1;
});

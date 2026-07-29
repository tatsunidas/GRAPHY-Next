import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

import { killProcessTree } from "../common/processUtils.js";
import { waitForHttp } from "../common/waitForHttp.js";
import { waitForBackendReady } from "../backend/healthcheck.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import type { Driver, DriverPorts } from "./types.js";
import { DEFAULT_PORTS } from "./types.js";

const ROOT = path.resolve(AUTOMATOR_ROOT, "..");
/**
 * desktop 実行時に backend の CWD にするディレクトリ（H2 DB `./data` / DICOM 保管庫 /
 * `./plugins` がここに作られる）。プラグインを置いて検証する側もこの場所を知る必要がある。
 */
export const DESKTOP_RUN_DATA_DIR = path.join(AUTOMATOR_ROOT, ".results", "run-data", "desktop");
const DESKTOP_DIR = path.join(ROOT, "desktop");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const BACKEND_JAR = path.join(ROOT, "backend", "target", "graphy-next-backend.jar");

export class DesktopDriver implements Driver {
  readonly mode = "desktop" as const;
  readonly ports: DriverPorts;

  private backendProc: ChildProcess | null = null;
  private viteProc: ChildProcess | null = null;
  private electronApp: ElectronApplication | null = null;
  private mainPage: Page | null = null;

  constructor(ports: Partial<DriverPorts> = {}) {
    this.ports = { ...DEFAULT_PORTS, ...ports };
  }

  get page(): Page {
    if (!this.mainPage) throw new Error("DesktopDriver.start() がまだ完了していません");
    return this.mainPage;
  }

  async start(): Promise<void> {
    if (!fs.existsSync(BACKEND_JAR)) {
      throw new Error(
        `backend jar が見つかりません: ${BACKEND_JAR}\n` +
        `先に "cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package" を実行してください。`,
      );
    }
    const dataDir = DESKTOP_RUN_DATA_DIR;
    fs.mkdirSync(dataDir, { recursive: true });

    this.backendProc = spawn(
      "java",
      [
        "-jar", BACKEND_JAR,
        "--spring.profiles.active=standalone",
        `--server.port=${this.ports.http}`,
        `--graphy.dicom.scp.port=${this.ports.scp}`,
      ],
      {
        cwd: dataDir,
        stdio: ["ignore", "pipe", "pipe"],
        // reset エンドポイント(/api/automator/reset)を有効化。automator が spawn する backend には
        // 常にこれを設定する（本物の standalone インストーラ起動では絶対に設定してはならない）。
        env: { ...process.env, GRAPHY_AUTOMATOR: "1" },
      },
    );
    this.backendProc.stdout?.on("data", () => {});
    this.backendProc.stderr?.on("data", () => {});
    await waitForBackendReady(this.ports.http);

    this.viteProc = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "dev", "--", "--port", String(this.ports.vite), "--strictPort"],
      // detached: npm→node(vite) をプロセスグループリーダー化し、stop() の killProcessTree が
      // 負pid(グループ)で子孫ごと殺せるようにする（里子化した vite の残留とハングを防ぐ）。
      { cwd: FRONTEND_DIR, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
    );
    this.viteProc.stdout?.on("data", () => {});
    this.viteProc.stderr?.on("data", () => {});
    await waitForHttp({ host: "localhost", port: this.ports.vite, path: "/", timeoutMs: 60_000 });

    const requireFromDesktop = createRequire(path.join(DESKTOP_DIR, "package.json"));
    const electronPath = requireFromDesktop("electron") as unknown as string;

    this.electronApp = await electron.launch({
      executablePath: electronPath,
      args: [DESKTOP_DIR],
      cwd: DESKTOP_DIR,
      env: {
        ...process.env,
        GRAPHY_DEV: "1",
        GRAPHY_BACKEND_EXTERNAL: "1",
        GRAPHY_BACKEND_PORT: String(this.ports.http),
        GRAPHY_DEV_SERVER_URL: `http://localhost:${this.ports.vite}`,
      },
    });

    const viteOrigin = `http://localhost:${this.ports.vite}`;
    // window イベントの predicate だけに頼らない: イベント発火時点では url() が about:blank の
    // ことがあり、そのまま待ち続けて timeout → firstWindow() にフォールバックすると
    // **DevTools ウィンドウ**（GRAPHY_DEV=1 で開く devtools://…）を掴んでしまう。
    // 実際にそれで「MainScreen が出ない」と誤検知した（2026-07-30）。現存ウィンドウを
    // ポーリングして url が Vite オリジンのものを選ぶ。
    const mainWin = await this.findWindow((url) => url.startsWith(viteOrigin), 60_000);
    if (!mainWin) {
      const urls = this.electronApp.windows().map((w) => w.url());
      throw new Error(`アプリのメインウィンドウ（${viteOrigin}）が見つかりません。開いている url: ${JSON.stringify(urls)}`);
    }
    await mainWin.waitForLoadState("domcontentloaded");
    this.mainPage = mainWin;
  }

  /** 条件に合う url を持つウィンドウが現れるまでポーリングする（about:blank 経過を吸収する）。 */
  private async findWindow(match: (url: string) => boolean, timeoutMs: number): Promise<Page | null> {
    const app = this.electronApp;
    if (!app) return null;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = app.windows().find((w) => match(w.url()));
      if (found) return found;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async stop(): Promise<void> {
    if (this.electronApp) {
      await this.electronApp.close().catch(() => {});
      this.electronApp = null;
    }
    if (this.viteProc) {
      killProcessTree(this.viteProc);
      this.viteProc = null;
    }
    if (this.backendProc) {
      killProcessTree(this.backendProc);
      this.backendProc = null;
    }
    this.mainPage = null;
  }

  async waitForNewPage(
    trigger: () => Promise<void>,
    urlPredicate: (url: string) => boolean,
    timeoutMs = 30_000,
  ): Promise<Page> {
    if (!this.electronApp) throw new Error("DesktopDriver.start() がまだ完了していません");
    // start() と同じ理由（イベント時点の url が about:blank になり得る）で、イベント待ちに
    // 加えて現存ウィンドウのポーリングでも探す。
    const [win] = await Promise.all([
      this.electronApp
        .waitForEvent("window", { predicate: (w) => urlPredicate(w.url()), timeout: timeoutMs })
        .catch(() => this.findWindow(urlPredicate, timeoutMs)),
      trigger(),
    ]);
    if (!win) throw new Error("trigger() で開くはずのウィンドウが見つかりませんでした");
    await win.waitForLoadState("domcontentloaded");
    return win;
  }

  async mockNativeDirectoryPicker(path: string): Promise<void> {
    if (!this.electronApp) throw new Error("DesktopDriver.start() がまだ完了していません");
    await this.electronApp.evaluate(({ dialog }, dirPath) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dirPath] })) as typeof dialog.showOpenDialog;
    }, path);
  }
}

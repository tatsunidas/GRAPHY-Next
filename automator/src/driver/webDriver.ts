import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
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
const FRONTEND_DIR = path.join(ROOT, "frontend");
const BACKEND_JAR = path.join(ROOT, "backend", "target", "graphy-next-backend.jar");

export class WebDriver implements Driver {
  readonly mode = "web" as const;
  readonly ports: DriverPorts;

  private backendProc: ChildProcess | null = null;
  private viteProc: ChildProcess | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private mainPage: Page | null = null;

  constructor(ports: Partial<DriverPorts> = {}) {
    this.ports = { ...DEFAULT_PORTS, ...ports };
  }

  get page(): Page {
    if (!this.mainPage) throw new Error("WebDriver.start() がまだ完了していません");
    return this.mainPage;
  }

  async start(): Promise<void> {
    if (!fs.existsSync(BACKEND_JAR)) {
      throw new Error(
        `backend jar が見つかりません: ${BACKEND_JAR}\n` +
        `先に "cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package" を実行してください。`,
      );
    }
    const dataDir = path.join(AUTOMATOR_ROOT, ".results", "run-data", "web");
    fs.mkdirSync(dataDir, { recursive: true });

    this.backendProc = spawn(
      "java",
      [
        "-jar", BACKEND_JAR,
        "--spring.profiles.active=web",
        `--server.port=${this.ports.http}`,
      ],
      {
        cwd: dataDir,
        stdio: ["ignore", "pipe", "pipe"],
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

    this.browser = await chromium.launch();
    this.context = await this.browser.newContext();
    this.mainPage = await this.context.newPage();
    await this.mainPage.goto(`http://localhost:${this.ports.vite}`);
    await this.mainPage.waitForLoadState("domcontentloaded");
  }

  async stop(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.context = null;
      this.mainPage = null;
    }
    if (this.viteProc) {
      killProcessTree(this.viteProc);
      this.viteProc = null;
    }
    if (this.backendProc) {
      killProcessTree(this.backendProc);
      this.backendProc = null;
    }
  }

  async waitForNewPage(
    trigger: () => Promise<void>,
    urlPredicate: (url: string) => boolean,
    timeoutMs = 30_000,
  ): Promise<Page> {
    if (!this.context) throw new Error("WebDriver.start() がまだ完了していません");
    const [page] = await Promise.all([
      this.context.waitForEvent("page", { predicate: (p) => urlPredicate(p.url()), timeout: timeoutMs }),
      trigger(),
    ]);
    await page.waitForLoadState("domcontentloaded");
    return page;
  }
}

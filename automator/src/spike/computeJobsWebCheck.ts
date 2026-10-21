/*
 * web モードで「計算ジョブ…」のメニュー・API が出ないことの実機検証。GP-JOB-001 の「実機確認待ち」5（受入条件 11）。
 * 段 1・2 では「コード上は standalone のみ」で、画面では確かめていなかった。
 *
 * 実行:  cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package   （backend jar）
 *        cd automator && npx tsx src/spike/computeJobsWebCheck.ts
 *
 * 本物の backend jar（--spring.profiles.active=web）＋ vite dev ＋ chromium（Playwright）。専用ポートは
 * GRAPHY_AUTOMATOR_HTTP_PORT / _VITE_PORT。スクリーンショットは .results/compute-jobs-web-check。
 *   [0] 前提: web で起動している（/api/status の mode=web）。System メニューが開き、他の項目（DB 管理＝web では無効）が実在する
 *   [1] 負例: 「計算ジョブ…」の項目が無い。同じ System メニューの他の項目は有る
 *   [2] /api/compute/jobs が 2xx を返さない（404 か 501）
 *   [3] 状態バーの欄: standalone でも計算ジョブが 1 件も無ければ出ない（欄は件数があるときだけ）ので、web で出ないことの証拠にならない → 未達とする
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium } from "@playwright/test";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const ROOT = path.join(AUTOMATOR_ROOT, "..");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-jobs-web-check");
const HTTP = Number(process.env.GRAPHY_AUTOMATOR_HTTP_PORT ?? "48291");
const SCP = Number(process.env.GRAPHY_AUTOMATOR_SCP_PORT ?? "48214");
const VITE = Number(process.env.GRAPHY_AUTOMATOR_VITE_PORT ?? "48293");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      /* まだ */
    }
    await sleep(500);
  }
  throw new Error(`応答しない: ${url}`);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "graphy-web-check-"));
  const procs: ChildProcess[] = [];
  try {
    const backend = spawn(
      "java",
      [
        "--add-opens", "java.base/java.io=ALL-UNNAMED",
        "--add-opens", "java.desktop/javax.imageio.stream=ALL-UNNAMED",
        "-jar", path.join(ROOT, "backend", "target", "graphy-next-backend.jar"),
        "--spring.profiles.active=web",
        `--server.port=${HTTP}`,
        `--graphy.dicom.scp.port=${SCP}`,
      ],
      { cwd: dataDir, stdio: "ignore" },
    );
    procs.push(backend);
    await waitHttp(`http://localhost:${HTTP}/api/status`);
    const vite = spawn("npm", ["run", "dev", "--", "--port", String(VITE), "--strictPort"], {
      cwd: path.join(ROOT, "frontend"),
      stdio: "ignore",
      detached: true,
      env: { ...process.env, VITE_BACKEND_URL: `http://localhost:${HTTP}` },
    });
    procs.push(vite);
    await waitHttp(`http://localhost:${VITE}/`);

    const status = (await (await fetch(`http://localhost:${HTTP}/api/status`)).json()) as { mode?: string };
    check(status.mode === "web", "（前提）backend が web モードで起動している（/api/status の mode）", status.mode);

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.addInitScript("localStorage.setItem('graphy.locale', 'ja')");
      await page.goto(`http://localhost:${VITE}/`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("mainscreen-menu-system").waitFor({ state: "visible", timeout: 60_000 });
      // 使い捨てのブラウザの初回表示（利用条件の確認）。これを閉じないとメニューが押せない
      const agree = page.getByRole("button", { name: /^(同意して使う|Agree)/ });
      await agree.waitFor({ state: "visible", timeout: 15_000 }).then(() => agree.click()).catch(() => undefined);
      await page.getByTestId("mainscreen-menu-system").click();
      await page.getByTestId("menu-item-dbadmin").waitFor({ state: "attached", timeout: 10_000 });
      check(true, "（前提）System メニューが開き、他の項目（DB 管理）が実在する");
      check((await page.getByTestId("menu-item-dbadmin").isDisabled()) || (await page.getByTestId("menu-item-dbadmin").getAttribute("aria-disabled")) === "true", "（前提）web では DB 管理が無効（standalone 専用の項目が web の表示になっている）");
      const items = await page.locator("[data-testid^=menu-item-]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
      console.log(`  System メニューの項目: ${JSON.stringify(items)}`);
      await page.screenshot({ path: path.join(OUT_DIR, "ui-01-web-system-menu.png") });
      check(items.length > 0 && !items.includes("menu-item-compute-jobs"), "🔴 「計算ジョブ…」の項目が web の System メニューに無い", items);
      check((await page.getByText(/計算ジョブ/).count()) === 0, "画面のどこにも『計算ジョブ』の文字が出ない");
    } finally {
      await browser.close();
    }

    for (const p of ["/api/compute/jobs", "/api/compute/jobs/nonexistent"]) {
      const r = await fetch(`http://localhost:${HTTP}${p}`);
      check(r.status === 404 || r.status === 501, `🔴 GET ${p} は 404／501（2xx でない）`, r.status);
    }
    console.log("  [未達] 状態バーの欄: standalone でも件数が無ければ出ないので、web で出ないことの証拠にならない（コードの条件は isStandalone のみ）");
  } finally {
    for (const p of procs.reverse()) {
      try {
        if (p.pid) process.kill(-p.pid, "SIGTERM");
      } catch {
        p.kill();
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

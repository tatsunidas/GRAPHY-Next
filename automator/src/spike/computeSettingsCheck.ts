/*
 * 外部の計算機（Jupyter Server）の設定画面と接続テストの実機検証。設計: fw/remote-compute-design.md（段 2）。
 *
 * 実行:  cd automator && GRAPHY_JUPYTER_PYTHON=C:\...\anaconda3\python.exe npx tsx src/spike/computeSettingsCheck.ts
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend ＋ 本物の jupyter_server）:
 *   1. 計算機を足すと **main が確認ダイアログを出す**（宛先の URL が載る）
 *   2. 平文 http（院内）の印が出る
 *   3. トークンを保存すると「設定済み」になり、**GET /api/settings にも接続先ファイルにも平文で載らない**
 *   4. 接続テストが通り、Python と GPU の有無が画面に出る
 *   5. トークンが違うと「計算機に届きませんでした」＋トークンの案内が出る
 *   6. **内部経路（/api/internal/**）は secret 無しでは 404**（レンダラ・プラグインから叩けない）
 *   7. 削除するとトークンも消える
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）、
 *       jupyter_server と ipykernel の入った python（GRAPHY_JUPYTER_PYTHON）。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-settings-check");
const ENDPOINT_ID = "automator-local";
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

async function startJupyter(python: string, port: number, token: string, root: string): Promise<ChildProcess> {
  const proc = spawn(python, [
    "-m", "jupyter_server",
    "--ServerApp.ip=127.0.0.1", `--ServerApp.port=${port}`, "--ServerApp.port_retries=0",
    "--ServerApp.open_browser=False", `--IdentityProvider.token=${token}`, `--ServerApp.root_dir=${root}`,
  ], { stdio: ["ignore", "ignore", "ignore"] });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `token ${token}` } });
      if (r.ok) return proc;
    } catch {
      /* まだ */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  proc.kill();
  throw new Error("jupyter_server did not start");
}

async function main(): Promise<void> {
  const python = process.env.GRAPHY_JUPYTER_PYTHON;
  if (!python || !fs.existsSync(python)) throw new Error("GRAPHY_JUPYTER_PYTHON を jupyter_server の入った python に設定してください");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jPort = await freePort();
  const jToken = crypto.randomBytes(16).toString("hex");
  const jRoot = fs.mkdtempSync(path.join(OUT_DIR, "jroot-"));
  const jupyter = await startJupyter(python, jPort, jToken, jRoot);
  console.log(`jupyter_server: http://127.0.0.1:${jPort}/`);

  const driver = new DesktopDriver();
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept()); // window.confirm（削除・消去）

    // main の確認ダイアログを横取りして「許可する」を返し、出た内容を記録する
    const cwd = await driver.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg: unknown[] };
      g.__dlg = [];
      dialog.showMessageBoxSync = ((...args: unknown[]) => {
        g.__dlg.push(args[args.length - 1]);
        return 0;
      }) as typeof dialog.showMessageBoxSync;
      return process.cwd();
    });
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    if (endpointsBackup !== null) fs.rmSync(endpointsFile);
    const dialogs = () =>
      driver.app.evaluate(() => (globalThis as unknown as { __dlg: { title?: string; detail?: string }[] }).__dlg);

    // --- 1. 内部経路は secret 無しでは見えない ---
    console.log("\n[1] 内部経路");
    const base = `http://localhost:${driver.ports.http}`;
    const noAuth = await fetch(`${base}/api/internal/compute/endpoints`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: '{"endpoints":[]}',
    });
    check(noAuth.status === 404, "🔴 secret 無しの内部経路は 404", noAuth.status);
    const wrong = await fetch(`${base}/api/internal/compute/endpoints`, {
      method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${"0".repeat(64)}` },
      body: '{"endpoints":[]}',
    });
    check(wrong.status === 404, "🔴 違う secret の内部経路は 404", wrong.status);

    // --- 2. 計算機を足す ---
    console.log("\n[2] 計算機を足す");
    await page.getByTestId("mainscreen-menu-system").click();
    await page.getByTestId("menu-item-settings").click();
    await page.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("settings-cat-compute").click();
    await page.getByTestId("compute-panel").waitFor({ state: "visible", timeout: 10_000 });
    check((await page.getByTestId("compute-unavailable").count()) === 0, "内部経路が使える（未接続の警告が出ない）");
    await page.getByTestId("compute-add").click();
    await page.getByTestId("compute-field-id").fill(ENDPOINT_ID);
    await page.getByTestId("compute-field-label").fill("Automator のローカル Jupyter");
    await page.getByTestId("compute-field-url").fill(`http://127.0.0.1:${jPort}`);
    await page.getByTestId("compute-form-save").click();
    await page.getByTestId(`compute-endpoint-${ENDPOINT_ID}`).waitFor({ state: "visible", timeout: 10_000 });
    const d1 = await dialogs();
    check(
      d1.length === 1 && String(d1[0].detail).includes(`http://127.0.0.1:${jPort}/`),
      "🔴 main が確認ダイアログを出し、宛先の URL が載る",
      d1,
    );
    const boxText = (await page.getByTestId(`compute-endpoint-${ENDPOINT_ID}`).textContent()) ?? "";
    check(/平文|plaintext/.test(boxText), "平文 http の印が出る", boxText);

    // --- 3. トークン ---
    console.log("\n[3] トークン");
    await page.getByTestId(`compute-token-${ENDPOINT_ID}`).fill(jToken);
    await page.getByTestId(`compute-endpoint-${ENDPOINT_ID}`).getByRole("button", { name: /保存|Save/ }).click();
    await page.waitForFunction(
      (id) => /設定済み|Set/.test(document.querySelector(`[data-testid="compute-endpoint-${id}"]`)?.textContent ?? ""),
      ENDPOINT_ID,
      { timeout: 10_000 },
    );
    check(true, "トークンを保存すると『設定済み』になる");
    const settings = await (await fetch(`${base}/api/settings`)).text();
    check(!settings.includes(jToken), "🔴 GET /api/settings にトークンが含まれない");
    const onDisk = fs.readFileSync(endpointsFile, "utf8");
    check(!onDisk.includes(jToken), "🔴 接続先ファイルにトークンが書かれない", onDisk);
    const secrets = path.join(cwd, "secrets.enc.json");
    check(!fs.existsSync(secrets) || !fs.readFileSync(secrets, "utf8").includes(jToken), "🔴 秘密ファイルが平文でない");

    // --- 4. 接続テスト ---
    console.log("\n[4] 接続テスト");
    await page.getByTestId(`compute-test-${ENDPOINT_ID}`).click();
    const ok = page.getByTestId("compute-test-ok");
    const failed = page.getByTestId("compute-test-failed");
    await Promise.race([ok.waitFor({ timeout: 120_000 }), failed.waitFor({ timeout: 120_000 })]);
    const okText = (await ok.count()) > 0 ? ((await ok.textContent()) ?? "") : "";
    check(okText.includes("Python"), "接続テストが通り、Python の版が出る", (await failed.count()) > 0 ? await failed.textContent() : okText);
    check(/GPU/.test(okText), "GPU の有無が出る", okText);
    console.log(`    → ${okText}`);
    await page.screenshot({ path: path.join(OUT_DIR, "1-test-ok.png") });

    // --- 5. 違うトークン ---
    console.log("\n[5] 違うトークン");
    await page.getByTestId(`compute-token-${ENDPOINT_ID}`).fill("wrong-token");
    await page.getByTestId(`compute-endpoint-${ENDPOINT_ID}`).getByRole("button", { name: /保存|Save/ }).click();
    await page.waitForTimeout(500);
    await page.getByTestId(`compute-test-${ENDPOINT_ID}`).click();
    await failed.waitFor({ timeout: 60_000 });
    const failText = (await failed.textContent()) ?? "";
    check(/届きません|Could not reach/.test(failText), "「計算機に届きませんでした」になる", failText);
    check(/トークン|token/i.test(failText), "トークンの誤りだと案内する", failText);
    check(!failText.includes("wrong-token"), "🔴 画面にトークンを出さない");
    await page.screenshot({ path: path.join(OUT_DIR, "2-test-auth-failed.png") });

    // --- 6. 削除 ---
    console.log("\n[6] 削除");
    await page.getByTestId(`compute-delete-${ENDPOINT_ID}`).click();
    await page.getByTestId(`compute-endpoint-${ENDPOINT_ID}`).waitFor({ state: "detached", timeout: 10_000 });
    const status = await page.evaluate(
      (key) => (window as unknown as { graphyDesktop: { secretStatus: (k: string) => Promise<{ hasValue: boolean }> } })
        .graphyDesktop.secretStatus(key),
      `compute.endpoint.${ENDPOINT_ID}.token`,
    );
    check(status.hasValue === false, "🔴 削除するとトークンも消える", status);
    check((await dialogs()).length === 1, "削除では確認ダイアログ（送信先の追加）を出さない");
  } finally {
    await driver.stop();
    jupyter.kill();
    if (endpointsFile) {
      if (endpointsBackup !== null) fs.writeFileSync(endpointsFile, endpointsBackup);
      else if (fs.existsSync(endpointsFile)) fs.rmSync(endpointsFile);
    }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

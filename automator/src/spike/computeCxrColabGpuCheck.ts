/*
 * 胸部X線レポートプラグインのモデル実行部（計算機の上の Python）が、外部の GPU（Google Colab T4）で動くかの実機検証。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18890 GRAPHY_AUTOMATOR_SCP_PORT=18891 GRAPHY_AUTOMATOR_VITE_PORT=18893 \
 *          npx tsx src/spike/computeCxrColabGpuCheck.ts
 *   前提: desktop/colab-oauth-client.json（.gitignore）・プラグインの作業コピー（GRAPHY_CXR_PLUGIN_DIR）・
 *         同じ画像で CPU 実行した結果（.results/compute-cxr-report-check-ok/state.json。computeCxrReportCheck.ts ok）。
 *   🔴 人の操作が要る: ログインしていなければブラウザが開く（5 分待つ）。Colab の利用枠を数分〜十数分使い、最後に解放する。
 *
 * 🔴 これはプラグインの実経路ではない。本体は胸部X線（CR/DX）を外部の計算機へ渡さない（dataset-local-only）ので、
 *    **画像は送らない**（inputs: []）。Colab 側で、同じ画像（NIH ChestX-ray14 の公開サンプル 00000003_000・出典は fixtures/cxr-dx）を
 *    Hugging Face から取得して npz にし、プラグインの実際のスクリプト（buildScript）をそのまま実行する。
 *    Colab の transformers は別の版なので、検証用のラッパーが 4.46.3 を入れる（プラグイン自身は環境を書き換えない）。
 */
import fs from "node:fs";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { consentWindow, createChecker } from "./computeSpikeShared.js";

const PLUGIN_ID = "cxr-colab-gpu-check";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-cxr-colab-gpu-check");
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");
const CPU_STATE = path.join(AUTOMATOR_ROOT, ".results", "compute-cxr-report-check-ok", "state.json");
const { check, summary } = createChecker();

async function pluginScript(): Promise<string> {
  const src = process.env.GRAPHY_CXR_PLUGIN_DIR ?? path.join(AUTOMATOR_ROOT, "..", "..", "graphy-next-plugin-cxr-report");
  const { buildScript } = (await import(path.join(src, "ui.js"))) as { buildScript: () => string };
  const plugin = buildScript();
  const wrapper = [
    "import io, json, os, subprocess, sys, time, urllib.request",
    "import numpy as np",
    "from PIL import Image",
    "T0 = time.time()",
    "subprocess.check_call([sys.executable, '-m', 'pip', 'install', '-q', '--disable-pip-version-check', 'transformers==4.46.3'])",
    "for m in [m for m in sys.modules if m.split('.')[0] in ('transformers', 'tokenizers', 'huggingface_hub')]:",
    "    del sys.modules[m]",
    "url = 'https://datasets-server.huggingface.co/rows?dataset=timm%2Fnih-chest-xray-14&config=default&split=test&offset=0&length=1'",
    "row = json.load(urllib.request.urlopen(url))['rows'][0]['row']",
    "assert row['image_id'] == '00000003_000', row['image_id']",
    "im = np.array(Image.open(io.BytesIO(urllib.request.urlopen(row['image']['src']).read())).convert('L')).astype(np.float32)",
    "os.makedirs('inputs', exist_ok=True)",
    "os.makedirs('outputs', exist_ok=True)",
    "meta = {'modality': 'DX', 'photometricInterpretation': 'MONOCHROME2', 'windowCenter': [128.0], 'windowWidth': [256.0]}",
    "np.savez('inputs/0.npz', volume=im[None], spacing=np.full(3, np.nan), **{'meta.json': np.frombuffer(json.dumps(meta).encode(), dtype=np.uint8)})",
    "setup_s = round(time.time() - T0, 1)",
    "import torch",
    "if torch.cuda.is_available():",
    "    torch.cuda.reset_peak_memory_stats()",
    `exec(compile(${JSON.stringify(plugin)}, 'cxr-report-plugin', 'exec'))`,
    "gpu = {'cuda': torch.cuda.is_available(), 'name': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,",
    "       'peakMiB': round(torch.cuda.max_memory_allocated() / 2**20) if torch.cuda.is_available() else None,",
    "       'setupSeconds': setup_s, 'totalSeconds': round(time.time() - T0, 1), 'torch': torch.__version__}",
    "json.dump(gpu, open('outputs/gpu.json', 'w'))",
  ].join("\n");
  return wrapper;
}

const PLUGIN_UI = `
export async function activate(host) {
  const input = window.__computeInput || {};
  const run = (window.__computeRun = { started: true, progress: [] });
  const r = await host.compute.runJob(
    { endpointId: input.endpointId, inputs: [], script: input.script, timeoutSec: 1800 },
    { onProgress: (p, m) => run.progress.push([p, m]) },
  );
  const out = { ok: r.ok, error: r.error, cancelled: r.cancelled };
  if (r.ok) {
    out.status = r.status; out.stdout = r.stdout; out.stderr = r.stderr;
    out.errorName = r.errorName; out.errorValue = r.errorValue; out.traceback = r.traceback; out.files = r.files;
    const dec = async (n) => { const b = await r.readFile(n); return b ? JSON.parse(new TextDecoder().decode(b)) : null; };
    out.report = await dec("report.json");
    out.gpu = await dec("gpu.json");
    const cam = await r.readFile("cam.npy");
    out.camBytes = cam ? cam.length : null;
  }
  run.outcome = out;
}
`;

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, "plugin.json"), JSON.stringify({
    id: PLUGIN_ID, name: "CXR Colab GPU Check", version: "0.1.0", engines: { graphy: ">=0.0.0", os: ["linux", "win32", "darwin"] },
    description: "Runs the CXR report script on an external GPU (code only, no image).", author: "automator", license: "MIT",
    contributes: ["mainscreen.menu"], ui: "ui.js", permissions: ["remote-compute"],
  }, null, 2));
  fs.writeFileSync(path.join(dst, "ui.js"), PLUGIN_UI);
  fs.rmSync(AUDIT, { force: true });
  const script = await pluginScript();
  check(script.length < 64 * 1024, `送るコードは本体の上限（64KB）に収まる（${script.length} 文字）`);

  const driver = new DesktopDriver();
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  let endpointId: string | null = null;
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    const cwd = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return process.cwd();
    });
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    if (endpointsBackup !== null) fs.rmSync(endpointsFile);

    console.log("\n[1] Google でログイン");
    await page.getByTestId("mainscreen-menu-system").click();
    await page.getByTestId("menu-item-settings").click();
    await page.getByTestId("settings-cat-compute").click();
    await page.getByTestId("compute-colab").waitFor({ state: "visible", timeout: 10_000 });
    if ((await page.getByTestId("compute-colab-account").count()) === 0) {
      console.log("    → ブラウザが開きます。Google アカウントでログインして許可してください（5 分待ちます）");
      await page.getByTestId("compute-colab-signin").click();
      await page.getByTestId("compute-colab-account").waitFor({ state: "visible", timeout: 300_000 });
    }
    await page.waitForFunction(() => !(document.querySelector('[data-testid="compute-colab-account"]')?.textContent ?? "").includes("…"), null, { timeout: 30_000 });
    const account = (await page.getByTestId("compute-colab-account").textContent()) ?? "";
    check(/@/.test(account), "ログインしたアカウントとプランが出る");

    console.log("\n[2] GPU の計算機を足して確保");
    const options = await page.getByTestId("compute-colab-spec").locator("option:not([disabled])").evaluateAll((os) =>
      os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
    console.log(`    使える種類: ${options.join(", ")}`);
    const pick = options.find((v) => v === "VARIANT_GPU/T4/SHAPE_STANDARD") ?? options.find((v) => v.startsWith("VARIANT_GPU/"));
    check(!!pick, "このアカウントで GPU の種類が選べる", options);
    if (!pick) throw new Error("GPU が選べません（未達）");
    await page.getByTestId("compute-colab-spec").selectOption(pick);
    await page.getByTestId("compute-colab-add").click();
    endpointId = `colab-${pick.split("/")[1].toLowerCase()}`;
    await page.getByTestId(`compute-endpoint-${endpointId}`).waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId(`compute-colab-ensure-${endpointId}`).click();
    await page.getByTestId(`compute-colab-release-${endpointId}`).waitFor({ state: "visible", timeout: 300_000 });
    await page.getByTestId(`compute-test-${endpointId}`).click();
    const ok = page.getByTestId("compute-test-ok");
    const failed = page.getByTestId("compute-test-failed");
    await Promise.race([ok.waitFor({ timeout: 180_000 }), failed.waitFor({ timeout: 180_000 })]);
    const okText = (await ok.count()) > 0 ? ((await ok.textContent()) ?? "") : "";
    console.log(`    → ${okText}`);
    check(/GPU: /.test(okText), "接続テストで GPU の名前が出る", okText);
    await page.getByTestId("dialog-close-button").click();

    console.log("\n[3] コードだけのジョブ（画像は送らない）で、モデルを GPU で実行");
    await page.evaluate((i) => {
      const w = window as unknown as Record<string, unknown>;
      w.__computeInput = i;
      w.__computeRun = undefined;
    }, { endpointId, script });
    await page.getByTestId("mainscreen-menu-plugins").click();
    await page.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    const win = await consentWindow(driver, 120_000);
    const url = (await win.getByTestId("consent-url").textContent()) ?? "";
    check(/\.colab\.dev\/?$/.test(url), "同意画面の送り先が Colab のランタイム", url);
    await win.screenshot({ path: path.join(OUT_DIR, "consent.png") });
    await win.getByTestId("consent-ack").check();
    await win.getByTestId("consent-send").click();
    const t0 = Date.now();
    await page.waitForFunction(() => !!(window as unknown as { __computeRun?: { outcome?: unknown } }).__computeRun?.outcome, null, { timeout: 1_800_000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const run: any = await page.evaluate(() => (window as unknown as { __computeRun: unknown }).__computeRun);
    const o = run.outcome;
    fs.writeFileSync(path.join(OUT_DIR, "outcome.json"), JSON.stringify(run, null, 2));
    console.log(`    実行 ${Math.round((Date.now() - t0) / 1000)} 秒`);

    console.log("\n[4] 結果");
    check(o.ok === true && o.status === "ok", "Colab で最後まで走る", { error: o.error, name: o.errorName, value: o.errorValue, tb: (o.traceback ?? []).slice(-3), stderr: String(o.stderr ?? "").slice(-400) });
    const rep = o.report;
    check(!!rep && rep.device === "cuda", "モデルが GPU（cuda）で動いた", rep?.device);
    check(!!o.gpu?.cuda && /T4|GPU|NVIDIA|Tesla/i.test(String(o.gpu?.name)), "GPU の名前", o.gpu);
    check(typeof rep?.findings === "string" && rep.findings.length > 20 && typeof rep?.impression === "string", "所見と印象の文が返る", rep?.findings?.slice?.(0, 60));
    check(!rep?.camError && rep?.cam?.shape?.length === 2 && fs.existsSync(CPU_STATE) && (o.camBytes ?? 0) > 100, "Grad-CAM が GPU でも作れる（cam.npy が返る）", { camError: rep?.camError, camBytes: o.camBytes });
    check(rep?.cam?.gap < 0.01, "再計算した確率が生成時の確率と一致している（GPU）", rep?.cam?.gap);
    if (fs.existsSync(CPU_STATE)) {
      const cpu = JSON.parse(fs.readFileSync(CPU_STATE, "utf8")).report;
      check(cpu.findings === rep?.findings && cpu.impression === rep?.impression, "同じ画像の CPU 実行と、生成文が一致する（GPU と CPU で同じ文）", { cpu: cpu.findings.slice(0, 80), gpu: rep?.findings?.slice?.(0, 80) });
    }
    console.log(`    GPU: ${JSON.stringify(o.gpu)}`);

    const events = fs.readFileSync(AUDIT, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    check(events.some((e: { event: string; host?: string }) => e.event === "egress-approved" && /\.colab\.dev$/.test(e.host ?? "")), "監査: 送り先の host が Colab");
    check(events.find((e: { event: string }) => e.event === "compute-finished")?.outcome === "ok", "監査: 終了が ok で残る");
  } finally {
    if (endpointId) {
      const r = await driver.page.evaluate((id) => (window as unknown as { graphyDesktop: any }).graphyDesktop.computeColabRelease(id), endpointId).catch((e) => ({ error: String(e) }));
      console.log(`    解放: ${JSON.stringify(r)}`);
    }
    await driver.stop();
    if (endpointsFile) {
      if (endpointsBackup !== null) fs.writeFileSync(endpointsFile, endpointsBackup);
      else fs.rmSync(endpointsFile, { force: true });
    }
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

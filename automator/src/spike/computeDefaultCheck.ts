/*
 * 既定の計算機（この PC → Colab）の実機検証。設計: fw/remote-compute-design.md §17
 *
 * 実行:  cd automator && PATH=<CUDA 版 torch・jupyter_server・ipykernel の入った venv の bin>:$PATH \
 *          SPIKE_NOGPU_PATH=<GPU の Python を含まない PATH> \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=18890 GRAPHY_AUTOMATOR_SCP_PORT=18891 GRAPHY_AUTOMATOR_VITE_PORT=18893 \
 *          npx tsx src/spike/computeDefaultCheck.ts
 *   起動前に frontend/node_modules/.vite を消すこと。Linux 専用。前提: backend jar・NVIDIA の GPU と nvidia-smi。
 *
 * 本物の Electron ＋ 本物の backend ＋ 本物の Python ＋ 本物の GPU。設定ファイルは実際に置いて読ませる。
 *   A  GPU の使える Python が見える／設定ファイルなし → 既定は「この PC」。Colab を足さない・Jupyter も起動しない（ensure は起動しない）
 *   B  同じ機で、Jupyter を登録して「既定にする」→ 登録が既定（GPU があっても選んだものが勝つ）。自動に戻す→この PC。知らない id は断る
 *   C  移行: 旧い設定ファイル（schemaVersion なし）
 *        C1 Jupyter だけ登録 → 既定はその Jupyter（GPU があっても変えない）。読むだけでファイルは不変。保存して初めて defaultId が入る
 *        C2 Colab T4 だけ登録 → 既定は自動＝この PC（決定どおり）。ファイルは不変
 *   D  負例: GPU の Python が見えない（CUDA 不可）→ 既定はこの PC にならない／ensure は Colab の理由で断り、Jupyter は起動しない
 *   E  負例: 「この PC」を選んでいるが Python が無い → local-unavailable（Colab に黙って落とさない）
 *   F  設定画面のスクリーンショット（既定の印・［既定にする］・［自動に戻す］）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-default-check");
// 開発起動の main は cwd（desktop/）を dataDir にする（computeLocalRunCheck も cwd を読んでいる）
const DATA_DIR = path.resolve(AUTOMATOR_ROOT, "..", "desktop");
const FILE = path.join(DATA_DIR, "compute-endpoints.json");
fs.mkdirSync(OUT_DIR, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "gn-default-check-"));

const LAB = { id: "lab", label: "Lab", kind: "jupyter", url: "https://lab.example/" };
const T4 = { id: "colab-t4", label: "Google Colab（GPU T4）", kind: "colab", spec: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" } };

type Cfg = { defaultId?: string | null; defaultMode?: string; defaultError?: string | null; defaultPending?: boolean; endpoints: { id: string }[] };
type Ens = { ok: boolean; endpointId?: string; added?: boolean; error?: string };
type Bridge = {
  computeEndpointsGet(): Promise<Cfg>;
  computeEnsureDefault(): Promise<Ens>;
  computeDefaultSet(id: string | null): Promise<{ ok: boolean; problems?: string[] }>;
  computeLocalDetect(o: unknown): Promise<{ usable: boolean; capabilities: { accelerator: string } | null }>;
};
const call = <T>(page: Page, fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(([f, a]) => (window as unknown as { graphyDesktop: Record<string, (...x: unknown[]) => unknown> }).graphyDesktop[f as string](...(a as unknown[])), [fn, args]) as Promise<T>;
const get = (p: Page) => call<Cfg>(p, "computeEndpointsGet");
const ensure = (p: Page) => call<Ens>(p, "computeEnsureDefault");
const detect = (p: Page) => call<Awaited<ReturnType<Bridge["computeLocalDetect"]>>>(p, "computeLocalDetect", { force: false });

function reset(content?: unknown): void {
  fs.rmSync(path.join(DATA_DIR, "compute-local"), { recursive: true, force: true });
  fs.rmSync(FILE, { force: true });
  if (content !== undefined) fs.writeFileSync(FILE, JSON.stringify(content, null, 2));
}
const bytes = () => (fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : null);
const localStarted = () => fs.existsSync(path.join(DATA_DIR, "compute-local", "server.json"));

async function withApp(label: string, env: Record<string, string>, fn: (d: DesktopDriver) => Promise<void>): Promise<void> {
  console.log(`\n===== ${label} =====`);
  const driver = new DesktopDriver(undefined, { extraEnv: env });
  try {
    await driver.start();
    await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
    });
    await fn(driver);
  } finally {
    await driver.stop();
  }
}

async function shot(driver: DesktopDriver, name: string): Promise<void> {
  const b64 = await driver.app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x: { webContents: { getURL(): string } }) => !x.webContents.getURL().startsWith("devtools://"));
    return w ? (await w.webContents.capturePage()).toPNG().toString("base64") : "";
  });
  if (b64) fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), Buffer.from(b64, "base64"));
}

async function openPanel(page: Page): Promise<void> {
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("settings-cat-compute").click();
  await page.getByTestId("compute-panel").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="compute-local-running"]') && document.querySelector('[data-testid="compute-local-headline"]'), undefined, { timeout: 180_000 });
}

async function main(): Promise<void> {
  const backup = bytes();
  const noGpuPath = process.env.SPIKE_NOGPU_PATH;
  try {
    // ── A ──
    reset();
    await withApp("A GPU の Python が見える・設定ファイルなし", {}, async (driver) => {
      const page = driver.page;
      const d = await detect(page);
      check(d.usable && d.capabilities?.accelerator === "cuda", "前提: この機の検出が CUDA 可（これが偽なら以下は意味を持たない）", d.capabilities);
      const r = await ensure(page);
      check(r.ok && r.endpointId === "local" && r.added === false, "既定は『この PC』（Colab を足さない）", r);
      check(bytes() === null, "🔴 設定ファイルを作っていない（足したものが無い）");
      check(!localStarted(), "ensure だけでは Jupyter を起動しない（計算するときに起動）");
      const c = await get(page);
      check(c.defaultId === "local" && c.defaultMode === "auto" && !c.defaultPending, "get: defaultId=local・自動", c);
    });

    // ── B ──
    reset({ schemaVersion: 2, endpoints: [LAB], defaultId: null });
    await withApp("B Jupyter を登録して『既定にする』", {}, async (driver) => {
      const page = driver.page;
      await detect(page);
      let c = await get(page);
      check(c.defaultId === "local" && c.defaultMode === "auto", "自動のままなら GPU のある自機（登録があっても）", c);
      const set = await call<{ ok: boolean }>(page, "computeDefaultSet", "lab");
      c = await get(page);
      check(set.ok && c.defaultId === "lab" && c.defaultMode === "chosen", "『既定にする』で登録した Jupyter が既定（GPU があっても選んだものが勝つ）", c);
      check((await ensure(page)).endpointId === "lab", "ensure も選んだもの");
      check(JSON.parse(bytes()!).defaultId === "lab", "ファイルに defaultId が書かれた");
      const bad = await call<{ ok: boolean; problems?: string[] }>(page, "computeDefaultSet", "nope");
      check(!bad.ok && (await get(page)).defaultId === "lab", "負例: 知らない id は断り、既定は変わらない", bad);
      await call(page, "computeDefaultSet", null);
      c = await get(page);
      check(c.defaultId === "local" && c.defaultMode === "auto" && JSON.parse(bytes()!).defaultId === null, "自動に戻すとこの PC", c);
      await call(page, "computeDefaultSet", "local");
      c = await get(page);
      check(c.defaultId === "local" && c.defaultMode === "chosen", "『この PC』を選ぶ（chosen）", c);
      // F 画面
      await openPanel(page);
      await page.waitForTimeout(2000);
      check((await page.getByTestId("compute-local-running").count()) === 0, "🔴 画面: 検出が描画のたびに走り直していない（結果が出た後に『確認中』が残らない）");
      check((await page.getByTestId("compute-local-default").count()) === 1, "画面: この PC に既定の印");
      check((await page.getByTestId("compute-make-default-lab").count()) === 1 && (await page.getByTestId("compute-default-lab").count()) === 0, "画面: 登録の行に［既定にする］があり、印は付かない");
      check((await page.getByTestId("compute-default-auto").count()) === 1, "画面: 選択済みのとき［自動に戻す］がある");
      await shot(driver, "F1-local-chosen");
      await page.getByTestId("compute-make-default-lab").click();
      await page.waitForFunction(() => !!document.querySelector('[data-testid="compute-default-lab"]'));
      check((await page.getByTestId("compute-local-default").count()) === 0, "画面: Lab を既定にすると、この PC の印が消えて印が Lab に移る");
      await shot(driver, "F2-lab-chosen");
    });

    // ── C ──
    const v1Lab = { endpoints: [LAB] };
    reset(v1Lab);
    const c1Before = bytes();
    await withApp("C1 移行: 旧い設定（schemaVersion なし）に Jupyter だけ", {}, async (driver) => {
      const page = driver.page;
      await detect(page);
      const c = await get(page);
      check(c.defaultId === "lab" && c.defaultMode === "chosen", "🔴 GPU があっても既定は利用者の Jupyter のまま（黙って変えない）", c);
      check((await ensure(page)).endpointId === "lab", "ensure も Jupyter");
      check(bytes() === c1Before, "🔴 読んだだけではファイルが不変（バイト列が同じ）");
      const set = await call<{ ok: boolean }>(page, "computeDefaultSet", null);
      check(set.ok && JSON.parse(bytes()!).defaultId === null && (await get(page)).defaultId === "local", "自動に戻す→この PC。ファイルに defaultId:null、接続先は残る");
      check(JSON.parse(bytes()!).endpoints.length === 1, "接続先の件数は変わらない");
    });
    reset({ endpoints: [T4] });
    const c2Before = bytes();
    await withApp("C2 移行: 旧い設定に Colab T4 だけ", {}, async (driver) => {
      const page = driver.page;
      await detect(page);
      const c = await get(page);
      check(c.defaultId === "local" && c.defaultMode === "auto", "Colab だった利用者は GPU のある機で既定がこの PC（決定どおり）", c);
      check(bytes() === c2Before, "読んだだけではファイルが不変");
    });

    // ── D 負例: GPU の Python が見えない ──
    if (!noGpuPath) console.log("  [未達] D: SPIKE_NOGPU_PATH が無い");
    else {
      reset({ endpoints: [T4] });
      await withApp("D GPU の Python が見えない（CUDA 不可）", { PATH: noGpuPath }, async (driver) => {
        const page = driver.page;
        const d = await detect(page);
        check(d.capabilities?.accelerator !== "cuda", "前提: この PATH では CUDA 不可（A とは違う）", d.capabilities);
        const c = await get(page);
        check(c.defaultId === "colab-t4", "🔴 既定は Colab のまま（自機にならない）", c);
        check((await ensure(page)).endpointId === "colab-t4", "ensure も Colab");
        check(!localStarted(), "自機の Jupyter は起動していない");
      });
      reset();
      await withApp("D2 同じ PATH・設定ファイルなし", { PATH: noGpuPath }, async (driver) => {
        const r = await ensure(driver.page);
        check(!r.ok && /colab-/.test(String(r.error)) && !localStarted() && bytes() === null, "登録なし: Colab の理由で断る（自機に落とさない・Jupyter を起動しない・何も書かない）", r);
      });
    }

    // ── E 負例: 自機を選んでいるが Python が無い ──
    reset({ schemaVersion: 2, endpoints: [T4], defaultId: "local" });
    const emptyDir = fs.mkdtempSync(path.join(work, "emptypath-"));
    const fakeHome = fs.mkdtempSync(path.join(work, "home-"));
    await withApp("E 『この PC』を選んだが Python が無い", { PATH: emptyDir, HOME: fakeHome }, async (driver) => {
      const page = driver.page;
      const r = await ensure(page);
      check(!r.ok && r.error === "local-unavailable", "🔴 Colab に黙って落とさず local-unavailable", r);
      const d = await detect(page);
      check(!d.usable, "前提: この PATH では Python が使えない（A とは違う）");
      const c = await get(page);
      check(c.defaultError === "local-unavailable", "get: defaultError", c);
      await openPanel(page);
      check((await page.getByTestId("compute-default-current").textContent())?.includes("使えません") || (await page.getByTestId("compute-default-current").textContent())?.includes("not usable"), "画面: 選んだ先が使えない旨が出る");
      await shot(driver, "F3-local-unavailable");
    });
  } finally {
    if (backup !== null) fs.writeFileSync(FILE, backup);
    else fs.rmSync(FILE, { force: true });
    fs.rmSync(path.join(DATA_DIR, "compute-local"), { recursive: true, force: true });
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

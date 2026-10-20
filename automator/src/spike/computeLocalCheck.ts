/*
 * 設定＞計算機＞「この PC」（Python と GPU の検出）の実機検証。設計: fw/remote-compute-design.md「この PC の Python と GPU の検出」
 *
 * 実行:  cd automator && SPIKE_VENV_EMPTY=<空の venv> SPIKE_VENV_CPU=<CPU 版 torch と jupyter_server 入りの venv> \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=18890 GRAPHY_AUTOMATOR_SCP_PORT=18891 GRAPHY_AUTOMATOR_VITE_PORT=18893 \
 *          npx tsx src/spike/computeLocalCheck.ts
 *   起動前に frontend/node_modules/.vite を消すこと。Linux 専用（偽の Python は sh）。
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend ＋ 本物の Python）。結果は 合格・失敗・未達 に分けて数える。
 *   A  普通の起動
 *      1. 候補が見つかり、jupyter_server・ipykernel のある Python が選ばれる（足りない案内に jupyter_server が出ない＝正例）
 *      2. 検出しただけでは接続先の設定ファイルを書かない・既定の計算機の規則は変わらない
 *      3. 空の venv を「指定」すると、足りない名前とコピー用のコマンドが出る（負例）。その venv の pip list は前後で同じ
 *      4. CPU 版 torch（本物）の venv を指定し、nvidia-smi が無い機では『CPU 版』の理由が出ない（理由が変わる負例）
 *      5. 壊れた出力・非 0 終了の Python でも落ちず、候補の行に理由が出る
 *      6. 取り消すと子プロセスが残らない（取り消す前は生きている＝負例）
 *      7. 『自動』に戻せる。設定ファイルは schemaVersion 2 で接続先を保ったまま
 *   B  偽の nvidia-smi を PATH に置いた起動（GPU の正例ではない。偽の nvidia-smi は CSV を出すだけ）
 *      1. CPU 版 torch（本物）の venv → 『CPU 版』の理由が出て CUDA 可にならない
 *      2. 偽の Python（記録 JSON を出すだけ）で、CUDA 可・世代が含まれない・ドライバが古い の表示の経路を撮る。
 *         これは『表示の経路』の確認で、合格にも失敗にも数えず「参考」に記録する
 *   C  PATH を空・HOME を空フォルダにして起動 → 「Python が見つかりません」と探した場所
 *   未達にするもの（この機では測れない）: NVIDIA ドライバの入った機での GPU 名・VRAM の一致、CUDA 可、世代の実物、
 *      Windows の WindowsApps の代役、CLT の無い macOS
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-local-check");
const DESKTOP_DIR = path.resolve(AUTOMATOR_ROOT, "..", "desktop");
const ENDPOINTS_FILE = path.join(DESKTOP_DIR, "compute-endpoints.json");

const failures: string[] = [];
const unreached: string[] = [];
const info: string[] = [];
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
function skip(label: string, why: string): void {
  console.log(`  [未達] ${label} — ${why}`);
  unreached.push(`${label}（${why}）`);
}
function note(label: string, detail: unknown): void {
  console.log(`  [参考] ${label} — ${JSON.stringify(detail)}`);
  info.push(label);
}

type Cand = { path: string; source: string; status: string; reasons: string[]; detail?: string; elapsedMs?: number };
type Detect = {
  state: string; python: { mode: string; path?: string }; selected: Cand | null; usable: boolean; candidates: Cand[];
  searched: string[]; nvidia: { found: boolean; gpus: { name: string; memoryMiB: number | null }[] };
  capabilities: { accelerator: string; devices: { name: string | null; memoryMiB: number | null; archSupported: boolean | null }[] } | null;
  reasons: string[]; guidance: { missing: string[]; commands: { text: string }[]; links: string[] }; elapsedMs: number;
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), "gn-local-check-"));
fs.mkdirSync(OUT_DIR, { recursive: true });
const timings: Record<string, unknown> = {};

function venvPython(dir: string | undefined): string | null {
  if (!dir) return null;
  const p = path.join(dir, "bin", "python");
  return fs.existsSync(p) ? p : null;
}
const emptyPy = venvPython(process.env.SPIKE_VENV_EMPTY);
const cpuPy = venvPython(process.env.SPIKE_VENV_CPU);

function pipList(py: string): string {
  return execFileSync(py, ["-m", "pip", "list", "--format=freeze"], { encoding: "utf8" });
}

function script(name: string, body: string): string {
  const p = path.join(work, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function shot(driver: DesktopDriver, name: string): Promise<void> {
  const b64 = await driver.app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x: { webContents: { getURL(): string } }) => !x.webContents.getURL().startsWith("devtools://"));
    if (!w) return "";
    return (await w.webContents.capturePage()).toPNG().toString("base64");
  });
  if (b64) fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), Buffer.from(b64, "base64"));
}

async function openPanel(page: Page): Promise<void> {
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("settings-cat-compute").click();
  await page.getByTestId("compute-panel").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("compute-local").waitFor({ state: "visible", timeout: 10_000 });
}

/** 確認が終わる（経過表示が消え、結果か取り消しが出る）まで待つ。 */
async function settled(page: Page, ms = 120_000): Promise<void> {
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="compute-local-running"]') &&
      (document.querySelector('[data-testid="compute-local-headline"]') || document.querySelector('[data-testid="compute-local-canceled"]')),
    undefined,
    { timeout: ms },
  );
}

const panelText = async (page: Page): Promise<string> => (await page.getByTestId("compute-local").textContent()) ?? "";
const detectJson = (page: Page, force = false): Promise<Detect> =>
  page.evaluate(
    (f) => (window as unknown as { graphyDesktop: { computeLocalDetect(o: unknown): Promise<unknown> } }).graphyDesktop.computeLocalDetect({ force: f }),
    force,
  ) as Promise<Detect>;

/** main のファイル選択と確認を、指定のパスを返す／許可する形に差し替える（利用者が窓で操作するのと同じ経路を通る）。 */
async function stubDialogs(driver: DesktopDriver): Promise<void> {
  await driver.app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __next: string; __dlg: unknown[] };
    g.__dlg = [];
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [g.__next] })) as unknown as typeof dialog.showOpenDialog;
    dialog.showMessageBoxSync = ((...args: unknown[]) => {
      g.__dlg.push(args[args.length - 1]);
      return 0;
    }) as typeof dialog.showMessageBoxSync;
  });
}
const setNext = (driver: DesktopDriver, p: string): Promise<void> =>
  driver.app.evaluate((_a, v) => { (globalThis as unknown as { __next: string }).__next = v; }, p);
const dialogs = (driver: DesktopDriver): Promise<{ detail?: string }[]> =>
  driver.app.evaluate(() => (globalThis as unknown as { __dlg: { detail?: string }[] }).__dlg);

async function pick(driver: DesktopDriver, p: string, wait = true): Promise<void> {
  await setNext(driver, p);
  await driver.page.getByTestId("compute-local-pick").click();
  if (wait) {
    await driver.page.waitForTimeout(300);
    await settled(driver.page);
  }
}

async function withApp(label: string, extraEnv: Record<string, string>, fn: (d: DesktopDriver) => Promise<void>): Promise<void> {
  console.log(`\n===== ${label} =====`);
  fs.rmSync(path.join(DESKTOP_DIR, "compute-local"), { recursive: true, force: true });
  if (fs.existsSync(ENDPOINTS_FILE)) fs.rmSync(ENDPOINTS_FILE);
  const driver = new DesktopDriver(undefined, { extraEnv });
  try {
    await driver.start();
    await stubDialogs(driver);
    await fn(driver);
  } finally {
    await driver.stop();
  }
}

async function main(): Promise<void> {
  const backup = fs.existsSync(ENDPOINTS_FILE) ? fs.readFileSync(ENDPOINTS_FILE, "utf8") : null;
  try {
    // ── A 普通の起動 ───────────────────────────────────────
    await withApp("A 普通の起動", {}, async (driver) => {
      const page = driver.page;
      const get = () => page.evaluate(() => (window as unknown as { graphyDesktop: { computeEndpointsGet(): Promise<{ endpoints: unknown[]; local: unknown }> } }).graphyDesktop.computeEndpointsGet());
      const before = await get();
      await openPanel(page);
      await settled(page);
      await shot(driver, "A1-auto");
      const r = await detectJson(page);
      timings.A_auto = { elapsedMs: r.elapsedMs, candidates: r.candidates.map((c) => ({ source: c.source, status: c.status, elapsedMs: c.elapsedMs })) };
      console.log("[A1] 自動で探す");
      check(r.state === "ok" && r.candidates.length > 0, "候補が見つかり、結果が返る", { state: r.state, n: r.candidates.length });
      check(!!r.selected && r.usable && !r.selected.reasons.includes("missing-jupyter-server"), "jupyter_server・ipykernel のある Python が選ばれる（正例）", r.selected);
      const t1 = await panelText(page);
      const missingText = (await page.getByTestId("compute-local-missing").count()) > 0 ? ((await page.getByTestId("compute-local-missing").textContent()) ?? "") : "";
      check(!/jupyter_server|ipykernel/.test(missingText), "正例: 足りない案内に jupyter_server・ipykernel が出ない", missingText);
      check((await page.getByTestId("compute-local-make-default").count()) === 1 && (await page.getByTestId("compute-local-default").count()) === 0, "この PC は既定ではなく、［既定にする］がある（CUDA 可の GPU が無い PATH）");
      check((await page.getByTestId("compute-local-detect").count()) === 1, "再検出ボタンがある");

      console.log("[A2] 検出しただけでは何も書かない");
      check(!fs.existsSync(ENDPOINTS_FILE), "接続先の設定ファイルが作られていない");
      const after = await get();
      check(JSON.stringify(before.endpoints) === JSON.stringify(after.endpoints) && (after.endpoints as unknown[]).length === 0, "接続先は 0 件のまま（既定の計算機の規則は変わらない）", after.endpoints);
      check(JSON.stringify(after.local) === JSON.stringify({ python: { mode: "auto" } }), "Python の設定は auto", after.local);

      console.log("[A3] 空の venv を指定（負例: 足りない）");
      if (!emptyPy) skip("空の venv の足りない案内・pip list", "SPIKE_VENV_EMPTY が無い");
      else {
        const pipBefore = pipList(emptyPy);
        await pick(driver, emptyPy);
        const d = await dialogs(driver);
        check(d.length === 1 && String(d[0].detail) === emptyPy, "main が確認ダイアログを出し、パスが載る", d);
        const r3 = await detectJson(page);
        check(r3.python.mode === "path" && r3.python.path === emptyPy, "指定した Python が使われる", r3.python);
        check(r3.selected?.status === "missing" && !r3.usable, "足りない Python として出る", r3.selected);
        const mt = (await page.getByTestId("compute-local-missing").textContent()) ?? "";
        check(/jupyter_server/.test(mt) && /ipykernel/.test(mt), "足りない名前（jupyter_server・ipykernel）が出る", mt);
        const cmd = (await page.getByTestId("compute-local-command").first().textContent()) ?? "";
        check(cmd.includes("-m pip install jupyter_server ipykernel") && cmd.includes(emptyPy), "コピー用のコマンドが出る", cmd);
        check((await page.getByTestId("compute-local-link").count()) === 1, "PyTorch 公式のページへのリンクが出る");
        await shot(driver, "A3-empty-venv");
        check(pipList(emptyPy) === pipBefore, "🔴 その Python の pip list が操作の前後で同じ（本体は何も入れない）");
        const onDisk = JSON.parse(fs.readFileSync(ENDPOINTS_FILE, "utf8"));
        check(onDisk.schemaVersion === 2 && onDisk.local.python.path === emptyPy && Array.isArray(onDisk.endpoints) && onDisk.endpoints.length === 0, "設定ファイルは schemaVersion 2・local に指定が入り、接続先は 0 件のまま", onDisk);
      }

      console.log("[A4] CPU 版 torch（本物）・nvidia-smi 無し");
      if (!cpuPy) skip("CPU 版 torch の venv", "SPIKE_VENV_CPU が無い");
      else {
        await pick(driver, cpuPy);
        const r4 = await detectJson(page);
        timings.A_cpuTorch = { elapsedMs: r4.elapsedMs, candidate: r4.candidates.find((c) => c.source === "setting")?.elapsedMs };
        check(r4.selected?.path === cpuPy && r4.usable, "jupyter_server・ipykernel・torch の揃った venv が使える", r4.selected);
        check(!r4.reasons.includes("torch-cpu-build"), "負例: nvidia-smi が無ければ『CPU 版』の理由は出ない（GPU が無いだけ）", r4.reasons);
        check(r4.capabilities?.accelerator === "cpu", "CUDA 可にならない", r4.capabilities);
        check(/見つかりませんでした|No NVIDIA GPU/.test(await panelText(page)), "『GPU は見つかりませんでした』が出る");
        await shot(driver, "A4-cpu-torch-no-smi");
      }

      console.log("[A5] 壊れた出力・非 0 終了");
      const bad3 = script("fake-exit3.sh", "echo boom >&2\nexit 3");
      await pick(driver, bad3);
      let r5 = await detectJson(page);
      check(r5.candidates[0]?.status === "probe-failed" && r5.candidates[0]?.detail === "exit:3", "非 0 終了は probe-failed（exit:3）", r5.candidates[0]);
      check((await page.getByTestId("compute-local-candidate-0").textContent())?.includes("exit:3") === true, "候補の行に理由が出る");
      await shot(driver, "A5-exit3");
      const garbage = script("fake-garbage.sh", "echo hello");
      await pick(driver, garbage);
      r5 = await detectJson(page);
      check(r5.candidates[0]?.detail === "probe-unparsable", "壊れた出力は probe-unparsable", r5.candidates[0]);
      check((await page.getByTestId("compute-local").count()) === 1, "どちらでも画面は落ちない");

      console.log("[A6] 取り消し");
      const pidFile = path.join(work, "hang.pid");
      const hang = script("fake-hang.sh", `echo $$ > "${pidFile}"\nexec sleep 600`);
      await setNext(driver, hang);
      await page.getByTestId("compute-local-pick").click();
      await page.getByTestId("compute-local-running").waitFor({ timeout: 15_000 });
      for (let i = 0; i < 40 && !fs.existsSync(pidFile); i++) await page.waitForTimeout(100);
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      check(pid > 0 && alive(pid), "負例: 取り消す前は子プロセスが生きている", pid);
      check(/確認中|Checking/.test((await page.getByTestId("compute-local-running").textContent()) ?? ""), "『確認中（経過 n 秒）』が出る");
      await shot(driver, "A6-running");
      await page.getByTestId("compute-local-cancel").click();
      await settled(page, 30_000);
      let gone = false;
      for (let i = 0; i < 30 && !gone; i++) {
        gone = !alive(pid);
        if (!gone) await page.waitForTimeout(100);
      }
      check(gone, "取り消すと子プロセスが残らない（kill -0 が失敗）", pid);
      check((await page.getByTestId("compute-local-canceled").count()) === 1, "『取り消しました』が出る");

      console.log("[A7] 自動に戻す");
      await page.getByTestId("compute-local-auto").click();
      await page.waitForTimeout(300);
      await settled(page);
      const r7 = await detectJson(page);
      check(r7.python.mode === "auto" && !!r7.selected, "自動に戻り、また候補が選ばれる", r7.python);
      const d7 = await dialogs(driver);
      check(d7.length >= 1, "自動に戻すときも main が確認する");
      const on7 = JSON.parse(fs.readFileSync(ENDPOINTS_FILE, "utf8"));
      check(on7.local.python.mode === "auto" && on7.schemaVersion === 2 && on7.endpoints.length === 0, "設定ファイルの local が auto", on7);
    });

    // ── B 偽の nvidia-smi ──────────────────────────────────
    const fakeBin = path.join(work, "fakebin");
    fs.mkdirSync(fakeBin);
    const FAKE_NAME = "SPIKE FAKE GPU 4GB";
    fs.writeFileSync(
      path.join(fakeBin, "nvidia-smi"),
      `#!/bin/sh\necho "${FAKE_NAME}, 4096, 580.00, GPU-spike-fake-0000"\n`,
      { mode: 0o755 },
    );
    await withApp("B 偽の nvidia-smi（CSV を出すだけ）", { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` }, async (driver) => {
      const page = driver.page;
      await openPanel(page);
      await settled(page);
      const r0 = await detectJson(page);
      check(r0.nvidia.found && r0.nvidia.gpus[0]?.name === FAKE_NAME && r0.nvidia.gpus[0]?.memoryMiB === 4096, "偽の nvidia-smi の出力が GPU 名と VRAM として読まれる（表示の経路）", r0.nvidia);
      console.log("[B1] CPU 版 torch（本物）＋ GPU あり");
      if (!cpuPy) skip("CPU 版 torch の理由", "SPIKE_VENV_CPU が無い");
      else {
        await pick(driver, cpuPy);
        const r1 = await detectJson(page);
        check(r1.reasons.includes("torch-cpu-build"), "『PyTorch が CPU 版です』の理由が出る", r1.reasons);
        check(r1.capabilities?.accelerator === "cpu", "CUDA 可にならない", r1.capabilities);
        const txt = await panelText(page);
        check(txt.includes(FAKE_NAME) && txt.includes("4096 MiB"), "画面の GPU 名と VRAM が nvidia-smi の値と一致（偽の値との一致）");
        check(/CPU 版|CPU build/.test(txt), "画面に『CPU 版』が出る");
        await shot(driver, "B1-cpu-build");
      }
      console.log("[B2] 偽の Python で表示の経路（参考）");
      const mk = (name: string, torch: Record<string, unknown>) =>
        script(name, `cat <<'EOF'\n__graphy_local_probe__${JSON.stringify({
          schema: 1, executable: "/fake/python", version: "3.11.9", prefix: "/fake", venv: true, conda: false, externallyManaged: false,
          jupyterServer: "2.14.0", ipykernel: "6.29.5", torchVersion: "2.8.0+cu126", torch,
        })}\nEOF`);
      const arch = ["sm_50", "sm_60", "sm_70", "sm_75", "sm_80", "sm_86", "sm_90"];
      const dev = [{ name: FAKE_NAME, totalMemory: 4228120576, capability: [6, 1], uuid: "spike-fake-0000" }];
      const fakes: [string, Record<string, unknown>, string][] = [
        ["cuda-ok", { version: "2.8.0+cu126", cuda: "12.6", available: true, mps: false, archList: arch, devices: dev }, "CUDA 可|CUDA available"],
        ["arch-unsupported", { version: "2.8.0+cu128", cuda: "12.8", available: true, mps: false, archList: ["sm_70", "sm_80", "sm_90"], devices: dev }, "計算能力 6.1|compute capability 6.1"],
        ["driver-old", { version: "2.8.0+cu126", cuda: "12.6", available: false, mps: false, archList: arch, devices: [] }, "ドライバ|driver"],
      ];
      for (const [name, torch, expect] of fakes) {
        await pick(driver, mk(`fake-${name}.sh`, torch));
        const t = await panelText(page);
        note(`表示の経路 ${name}: 『${expect}』が出る=${new RegExp(expect).test(t)}`, { reasons: (await detectJson(page)).reasons });
        await shot(driver, `B2-fake-${name}`);
      }
    });

    // ── C Python が無い ────────────────────────────────────
    const emptyDir = fs.mkdtempSync(path.join(work, "emptypath-"));
    const fakeHome = fs.mkdtempSync(path.join(work, "home-"));
    await withApp("C PATH を空・HOME を空フォルダにして起動", { PATH: emptyDir, HOME: fakeHome }, async (driver) => {
      const page = driver.page;
      await openPanel(page);
      await settled(page);
      const r = await detectJson(page);
      check(r.state === "none" && r.candidates.length === 0, "負例: 隠すと候補が 0 件（A では見つかった＝隠す操作が効いている）", { state: r.state, n: r.candidates.length });
      check(r.reasons.includes("no-python") && r.searched.length > 0, "no-python と探した場所の一覧が返る", r.searched.length);
      const t = await panelText(page);
      check(/見つかりません|No Python/.test(t), "『Python が見つかりません』が出る");
      await page.getByTestId("compute-local-candidates-summary").click();
      const s = (await page.getByTestId("compute-local-searched").textContent()) ?? "";
      check(s.includes("python3") && s.includes("anaconda3"), "探した場所の一覧（python3・conda の base）が画面に出る", s.slice(0, 200));
      check((await page.getByTestId("compute-local-make-default").isDisabled()), "Python が無いので［既定にする］は押せない");
      await shot(driver, "C-no-python");
    });
  } finally {
    if (backup !== null) fs.writeFileSync(ENDPOINTS_FILE, backup);
    else if (fs.existsSync(ENDPOINTS_FILE)) fs.rmSync(ENDPOINTS_FILE);
    fs.rmSync(path.join(DESKTOP_DIR, "compute-local"), { recursive: true, force: true });
  }

  skip("GPU 名・VRAM が実機の nvidia-smi と一致（受入 4 前半）", "この機は NVIDIA ドライバ未導入（nouveau）で nvidia-smi が無い");
  skip("CUDA 可の判定（実物）", "同上");
  skip("世代が含まれない／含まれる（Pascal の実物）", "同上");
  skip("ドライバが古い（実物）", "古いドライバの機が無い");
  skip("Windows の WindowsApps の代役が『除外』（実 OS）", "Windows 機が無い（単体は表で通る）");
  skip("CLT の無い macOS で /usr/bin/python3 を起動しない（実 OS）", "macOS 機が無い（単体は表で通る）");

  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify({ passed, failed: failures, unreached, info, timings }, null, 2));
  console.log(`\n合格 ${passed} / 失敗 ${failures.length} / 未達 ${unreached.length}（参考 ${info.length}）`);
  if (failures.length > 0) {
    console.log(`失敗: ${JSON.stringify(failures)}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/*
 * 外部から検査を開く（graphynext:// ・ --open-study ・ 単一インスタンス）の実アプリ検査。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=19620 GRAPHY_AUTOMATOR_SCP_PORT=19621 GRAPHY_AUTOMATOR_VITE_PORT=19623 \
 *          npx tsx src/spike/externalOpenCheck.ts [--control]
 *        （合成 CT に pydicom・numpy のある python3 が要る。backend の jar が要る）
 *   --control … 単一インスタンスを無効にして同じ起動をする対照。2 つ目が終了せず、検査も開かないこと（＝今までの動き）を確かめる。
 *
 * 2 つ目の Electron を、1 つ目と同じ userData（--user-data-dir）で起動し、引数で検査を渡す（RIS が実行ファイルや URL を呼ぶのと同じ形）。
 *   正例: `--open-study=<UID>` → 2 つ目は終了、1 つ目に 2D ビューアが出て、その検査が表示される。
 *         別の検査を渡す → 同じビューア窓が差し替わる（窓は増えない）。URL（graphynext://open?...）の引数でも同じ。
 *   負例: 存在しない UID／不正な UID／存在しないシリーズ → 何も開かず、理由が出る。受け付けない設定 → 開かず、その旨が出る。
 *   複数該当（同じ患者 ID・検査日）→ 選択画面が出て、選ぶまで開かない。確認ダイアログ（設定オン）→ 承諾するまで開かない。
 * 画面はスクリーンショットを .results/external-open-check に残す（目視用）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "external-open-check");
const DESKTOP_DIR = path.join(AUTOMATOR_ROOT, "..", "desktop");
const CONTROL = process.argv.includes("--control");
const { check, summary } = createChecker();

interface Truth { studyUid: string; seriesUid: string; patientName: string; sops: string[] }

function synth(): { dir: string; truth: Truth[]; dupStudyUid: string } {
  const dir = path.join(OUT_DIR, "synth");
  fs.rmSync(dir, { recursive: true, force: true });
  const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "retentionSynth.py"), dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  const truth = JSON.parse(fs.readFileSync(path.join(dir, "truth.json"), "utf8")) as Truth[];
  // 複数該当の検査用: s2 と同じ患者 ID・検査日で、UID だけ違う検査を作る
  const dup = spawnSync("python3", ["-I", "-c", `
import os, sys, pydicom
from pydicom.uid import generate_uid
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
study, series = generate_uid(), generate_uid()
for f in sorted(os.listdir(src)):
    if not f.endswith(".dcm"): continue
    ds = pydicom.dcmread(os.path.join(src, f))
    ds.StudyInstanceUID, ds.SeriesInstanceUID = study, series
    ds.SOPInstanceUID = generate_uid(); ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.StudyDescription = "duplicate of s2"
    ds.save_as(os.path.join(dst, f), enforce_file_format=True)
print(study)
`, path.join(dir, "s2"), path.join(dir, "s2dup")], { encoding: "utf8" });
  if (dup.status !== 0) throw new Error(`複製を作れません: ${dup.stderr}`);
  return { dir, truth, dupStudyUid: dup.stdout.trim() };
}

/** 2 つ目の Electron を起動し、終わるまで（最大 timeoutMs）待つ。終わらなければ殺して exited=false。 */
async function launchSecond(args: string[], userData: string, singleInstance: boolean, timeoutMs = 25_000): Promise<{ exited: boolean; code: number | null; ms: number }> {
  const requireFromDesktop = createRequire(path.join(DESKTOP_DIR, "package.json"));
  const electronPath = requireFromDesktop("electron") as unknown as string;
  const env: Record<string, string | undefined> = { ...process.env, GRAPHY_DEV: "1" };
  if (singleInstance) env.GRAPHY_SINGLE_INSTANCE = "1";
  else delete env.GRAPHY_SINGLE_INSTANCE;
  delete env.GRAPHY_DEV_DATA_DIR;
  const t0 = Date.now();
  const p = spawn(electronPath, [DESKTOP_DIR, `--user-data-dir=${userData}`, ...args], { env: env as Record<string, string>, stdio: "ignore", detached: true });
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { process.kill(-p.pid!, "SIGKILL"); } catch { /* 既に終わっている */ }
      resolve({ exited: false, code: null, ms: Date.now() - t0 });
    }, timeoutMs);
    p.on("exit", (code) => { clearTimeout(timer); resolve({ exited: true, code, ms: Date.now() - t0 }); });
  });
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { dir, truth, dupStudyUid } = synth();
  const [s1, s2, s3] = truth;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "graphy-extopen-"));
  const driver = new DesktopDriver(undefined, {
    extraEnv: CONTROL ? {} : { GRAPHY_SINGLE_INSTANCE: "1" },
    extraElectronArgs: [`--user-data-dir=${userData}`],
  });
  const base = `http://127.0.0.1:${driver.ports.http}`;
  const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  const viewers = () => driver.app.windows().filter((w) => w.url().includes("2dviewer"));
  const putSetting = (kv: Record<string, string>) => fetch(`${base}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(kv) });
  const wasOn = !CONTROL;

  try {
    await driver.start();
    const page = driver.page;
    await resetDb(driver.ports.http);
    for (const d of ["s1", "s2", "s3", "s2dup"]) {
      const imp = await importPaths(driver.ports.http, [path.join(dir, d)]);
      check(imp.imported === 4, `合成 CT（${d}）を 4 枚取り込めた`, imp);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await putSetting({ "external.openEnabled": "true", "external.openConfirm": "false" });

    console.log(`\n[0] 前提${CONTROL ? "（対照: 単一インスタンスを無効にした起動）" : ""}`);
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
    check(studies.some((s) => s.studyInstanceUid === s1.studyUid) && studies.some((s) => s.studyInstanceUid === dupStudyUid), "取り込んだ検査が backend にある", studies.length);
    check(viewers().length === 0, "最初は 2D ビューアが開いていない", viewers().length);

    if (CONTROL) {
      console.log("\n[C] 対照: 単一インスタンスが無いと、2 つ目は終了せず、検査も開かない（今までの動き）");
      const r = await launchSecond([`--open-study=${s1.studyUid}`], userData, false, 20_000);
      check(!r.exited, "2 つ目の起動が終了しない（別のアプリとして立ち上がる）", r);
      check(viewers().length === 0, "1 つ目に 2D ビューアは開かない", viewers().length);
      return;
    }

    console.log("\n[1] --open-study で、2 つ目は終了し、1 つ目に 2D ビューアが開く");
    const second = await launchSecond([`--open-study=${s1.studyUid}`], userData, true);
    check(second.exited && second.code === 0, `2 つ目の起動は終了する（${second.ms} ms）`, second);
    const t0 = Date.now();
    while (viewers().length === 0 && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 300));
    check(viewers().length === 1, "2D ビューアの窓が 1 つ開いた", viewers().length);
    if (viewers().length === 0) {
      await shot(page, "01-FAIL-main");
      console.log("  メイン画面のダイアログ:", await page.getByTestId("external-open-dialog").innerText().catch(() => "（無し）"));
      console.log("  開いている窓:", driver.app.windows().map((w) => w.url()));
      return;
    }
    const v = viewers()[0];
    await v.waitForFunction((n) => document.body.innerText.includes(n), s1.patientName, { timeout: 30_000 }).catch(() => undefined);
    check((await v.locator("body").innerText()).includes(s1.patientName), `ビューアに指定した検査（${s1.patientName}）が出ている`);
    await shot(v, "01-opened-s1");

    console.log("\n[2] 別の検査を渡すと、同じ窓が差し替わる（窓は増えない）。URL の引数でも同じ");
    const url2 = `graphynext://open?studyInstanceUid=${s3.studyUid}`;
    const r2 = await launchSecond([url2], userData, true);
    check(r2.exited && r2.code === 0, "URL を引数にした 2 つ目も終了する", r2);
    await v.waitForFunction((n) => document.body.innerText.includes(n), s3.patientName, { timeout: 30_000 }).catch(() => undefined);
    const body2 = await v.locator("body").innerText();
    check(body2.includes(s3.patientName), `同じ窓が ${s3.patientName} に差し替わった（${s3.patientName} は、渡す前の表示には無かった）`);
    check(viewers().length === 1, "ビューアの窓は 1 つのまま", viewers().length);
    await shot(v, "02-replaced-s3");

    console.log("\n[3] 負例: 存在しない検査・不正な UID・存在しないシリーズ → 何も変えず、理由が出る");
    const dlg = page.getByTestId("external-open-dialog");
    const closeDlg = async () => { await dlg.getByRole("button").last().click(); await dlg.waitFor({ state: "hidden", timeout: 5_000 }); };
    const unchanged = async (why: string) => {
      const b = await v.locator("body").innerText();
      check(b.includes(s3.patientName) && viewers().length === 1, `ビューアは ${s3.patientName} のまま・窓は増えない（${why}）`);
    };
    const missingUid = "9.9.9.9.9.9.1";
    await launchSecond([`--open-study=${missingUid}`], userData, true);
    await dlg.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
    const t3 = await dlg.innerText().catch(() => "");
    check(/検査が見つかりません|Study not found/.test(t3) && t3.includes(missingUid), "存在しない UID: 「検査が見つかりません（UID …）」が出る", t3);
    await shot(page, "03-not-found");
    await closeDlg();
    await unchanged("存在しない UID");

    await launchSecond(["--open-study=1.2;calc"], userData, true);
    await dlg.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
    const t4 = await dlg.innerText().catch(() => "");
    check(/受け付けられません|not accepted/.test(t4) && t4.includes("形式"), "不正な UID（;）: 形式の理由が出る", t4);
    await shot(page, "04-invalid");
    await closeDlg();
    await unchanged("不正な UID");

    await launchSecond([`--open-study=${s2.studyUid}`, "--open-series=1.2.3.4.5"], userData, true);
    await dlg.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
    const t5 = await dlg.innerText().catch(() => "");
    check(/シリーズが見つかりません|series was not found/.test(t5) && /別のシリーズは開きませんでした|No other series was opened/.test(t5), "存在しないシリーズ: 別のシリーズを開かず、理由が出る", t5);
    await closeDlg();
    await unchanged("存在しないシリーズ");

    console.log("\n[4] 複数該当（同じ患者 ID・検査日）→ 選択画面。選ぶまで開かない");
    await launchSecond([`graphynext://open?patientId=RETSYN2&studyDate=20260102`], userData, true);
    await dlg.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
    const t6 = await dlg.innerText().catch(() => "");
    check(/複数|Several/.test(t6) && t6.includes("retention check 2") && t6.includes("duplicate of s2"), "2 件を並べて選ばせる", t6);
    await shot(page, "05-choose");
    await unchanged("選ぶ前");
    await dlg.getByRole("button", { name: /duplicate of s2/ }).click();
    await dlg.waitFor({ state: "hidden", timeout: 5_000 });
    await v.waitForFunction((n) => document.body.innerText.includes(n), s2.patientName, { timeout: 30_000 }).catch(() => undefined);
    check((await v.locator("body").innerText()).includes(s2.patientName), `選んだ検査（${s2.patientName}）が開く`);

    console.log("\n[5] 1 件に絞れる患者 ID＋検査日 → そのまま開く");
    await launchSecond([`graphynext://open?patientId=RETSYN1&studyDate=20260101`], userData, true);
    await v.waitForFunction((n) => document.body.innerText.includes(n), s1.patientName, { timeout: 30_000 }).catch(() => undefined);
    check((await v.locator("body").innerText()).includes(s1.patientName), `選ばせずに ${s1.patientName} が開く`);

    console.log("\n[6] 設定: 開く前に確認する → 承諾するまで開かない");
    await putSetting({ "external.openConfirm": "true" });
    await launchSecond([`--open-study=${s3.studyUid}`], userData, true);
    await dlg.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
    const t7 = await dlg.innerText().catch(() => "");
    check(t7.includes(s3.patientName) && /開きますか|Open it/.test(t7), "患者名つきの確認が出る", t7);
    await shot(page, "06-confirm");
    await dlg.getByRole("button", { name: /キャンセル|Cancel/ }).click();
    check((await v.locator("body").innerText()).includes(s1.patientName), "キャンセルすると開かない（表示は変わらない）");
    await launchSecond([`--open-study=${s3.studyUid}`], userData, true);
    await dlg.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
    await dlg.getByRole("button", { name: /^(開く|Open)$/ }).click();
    await v.waitForFunction((n) => document.body.innerText.includes(n), s3.patientName, { timeout: 30_000 }).catch(() => undefined);
    check((await v.locator("body").innerText()).includes(s3.patientName), "「開く」で開く");
    await putSetting({ "external.openConfirm": "false" });

    console.log("\n[7] 設定: 受け付けない → 開かず、その旨が出る");
    await putSetting({ "external.openEnabled": "false" });
    await launchSecond([`--open-study=${s2.studyUid}`], userData, true);
    await dlg.waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
    const t8 = await dlg.innerText().catch(() => "");
    check(/設定でオフ|turned off/.test(t8), "「設定でオフになっているため開きませんでした」が出る", t8);
    await shot(page, "07-disabled");
    await closeDlg();
    check((await v.locator("body").innerText()).includes(s3.patientName), "表示は変わらない");
    await putSetting({ "external.openEnabled": "true" });
  } finally {
    if (wasOn) await putSetting({ "external.openEnabled": "true", "external.openConfirm": "false" }).catch(() => undefined);
    await driver.stop();
    fs.rmSync(userData, { recursive: true, force: true });
  }
  process.exitCode = summary() === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

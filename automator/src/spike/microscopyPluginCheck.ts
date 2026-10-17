/*
 * 公開プラグイン graphy-next-plugin-microscopy-import を実アプリで確かめる（fw/microscopy-cfm.md §5）。
 *
 * 実行:  cd automator && GRAPHY_TEST_PYTHON=<pydicom・numpy のある python> npx tsx src/spike/microscopyPluginCheck.ts
 *   プラグインのリポジトリ: GRAPHY_MICROSCOPY_PLUGIN（既定 ../../graphy-next-plugin-microscopy-import。backend を mvn package 済みであること）
 *   実データ: ~/graphy-workspace/open-testdata/lsm/Lan_Larval_Chitin_DMSO_control_01.lsm（Zenodo 16916709・CC BY 4.0。リポジトリには入れない）
 *
 * OS のファイル選択は自動では押せないので、Electron の graphy:pick-files を差し替えて実データのパスを返す。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const PLUGIN_ID = "microscopy-import";
const REPO = process.env.GRAPHY_MICROSCOPY_PLUGIN ?? path.join(AUTOMATOR_ROOT, "..", "..", "graphy-next-plugin-microscopy-import");
const DATA = path.join(os.homedir(), "graphy-workspace", "open-testdata");
const LSM = process.env.GRAPHY_TEST_LSM ?? path.join(DATA, "lsm", "Lan_Larval_Chitin_DMSO_control_01.lsm");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "microscopy-plugin");
const { check, summary } = createChecker();

const COMPARE = `
import sys, glob, json, pydicom, numpy as np
store, truth_dir = sys.argv[1], sys.argv[2]
out = []
for f in glob.glob(store + "/**/*.dcm", recursive=True):
    d = pydicom.dcmread(f)
    if d.Modality != "CFM": continue
    v = np.frombuffer(d.FloatPixelData, "<f4").reshape(int(d.NumberOfFrames), d.Rows, d.Columns)
    op = d.OpticalPathSequence[0]
    out.append({"desc": str(d.SeriesDescription), "frames": int(d.NumberOfFrames),
                "wave": float(op.IlluminationWaveLength) if "IlluminationWaveLength" in op else None, "v": v})
res = []
names = {"Ch1-T1": 0, "Ch2-T1": 1, "ChS1-T2": 2}
for o in out:
    c = names.get(o["desc"])
    t = np.fromfile(f"{truth_dir}/Lan_ch{c}.raw", "<u1").reshape(o["v"].shape).astype("<f4") if c is not None else None
    res.append({"desc": o["desc"], "frames": o["frames"], "wave": o["wave"], "maxdiff": None if t is None else float(np.abs(o["v"] - t).max())})
print(json.dumps(res))
`;

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jar = path.join(REPO, "backend", "target", "microscopy-import.jar");
  if (!fs.existsSync(jar)) throw new Error(`プラグインの JAR がありません（mvn package してください）: ${jar}`);
  if (!fs.existsSync(LSM)) throw new Error(`実データがありません: ${LSM}`);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(REPO, n), path.join(dst, n));
  fs.copyFileSync(jar, path.join(dst, "microscopy-import.jar"));

  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    await resetDb(driver.ports.http);
    const base = `http://localhost:${driver.ports.http}`;
    // ファイル選択を差し替える（実データのパスを返す）
    await driver.app.evaluate(({ ipcMain }, p) => {
      ipcMain.removeHandler("graphy:pick-files");
      ipcMain.handle("graphy:pick-files", () => ({ ok: true, paths: [p] }));
    }, LSM);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await page.getByTestId("mainscreen-menu-plugins").click();
    await page.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    await page.getByTestId("micro-pick").click();
    await page.waitForFunction(() => /Zeiss LSM: 512×512×20/.test(document.querySelector('[data-testid="micro-meta"]')?.textContent ?? ""), null, { timeout: 60_000 });
    const metaText = await page.getByTestId("micro-meta").innerText();
    check(/405 nm/.test(metaText) && /633 nm/.test(metaText) && /488 nm/.test(metaText), "下読みに 3 チャネルと波長（405・633・488 nm）が出る", metaText);
    check((await page.getByTestId("micro-spacing-z").inputValue()) === "2", `Z の画素間隔が 2 µm と読める（${await page.getByTestId("micro-spacing-z").inputValue()}）`);
    await page.getByTestId("micro-patient-id").fill("LSM-PLUGIN");
    await page.screenshot({ path: path.join(OUT_DIR, "plugin-window.png") });
    await page.getByTestId("micro-import").click();
    await page.getByTestId("plugin-microscopy-consent").waitFor({ state: "visible", timeout: 60_000 });
    await page.screenshot({ path: path.join(OUT_DIR, "consent.png") });
    await page.getByTestId("plugin-microscopy-consent-ok").click();
    await page.waitForFunction(() => /取り込みました|取り込めませんでした/.test(document.querySelector('[data-testid="micro-result"]')?.textContent ?? ""), null, { timeout: 120_000 });
    const result = await page.getByTestId("micro-result").innerText();
    check(/取り込みました: 3 シリーズ/.test(result), `取り込みの結果（${result}）`);
    await page.screenshot({ path: path.join(OUT_DIR, "done.png") });

    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId: string }[];
    check(studies.filter((s) => s.patientId === "LSM-PLUGIN").length === 1, "1 検査にまとまる");
    const tmpLeft = fs.existsSync(path.join(os.tmpdir(), "graphy-plugin-microscopy", PLUGIN_ID))
      ? fs.readdirSync(path.join(os.tmpdir(), "graphy-plugin-microscopy", PLUGIN_ID)).flatMap((d) => fs.readdirSync(path.join(os.tmpdir(), "graphy-plugin-microscopy", PLUGIN_ID, d)))
      : [];
    check(tmpLeft.length === 0, `プラグインの一時ファイルが残らない（${tmpLeft.length}）`, tmpLeft);
    const cmp = spawnSync(process.env.GRAPHY_TEST_PYTHON ?? "python3", ["-c", COMPARE, path.join(DESKTOP_RUN_DATA_DIR, "data", "dicom"), path.join(path.dirname(LSM), "truth")], { encoding: "utf8" });
    if (cmp.status !== 0) throw new Error(cmp.stderr);
    const rows = JSON.parse(cmp.stdout) as { desc: string; frames: number; wave: number | null; maxdiff: number | null }[];
    for (const r of rows) {
      check(r.frames === 20 && r.maxdiff === 0, `${r.desc}: 20 フレーム、値の差 ${r.maxdiff}（tifffile と比べて）`);
    }
    const waves = Object.fromEntries(rows.map((r) => [r.desc, r.wave]));
    check(waves["Ch1-T1"] === 405 && waves["Ch2-T1"] === 633 && waves["ChS1-T2"] === 488, "照明の波長が CFM に入る（405・633・488 nm）", waves);
  } finally {
    await driver.stop();
    fs.rmSync(dst, { recursive: true, force: true });
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

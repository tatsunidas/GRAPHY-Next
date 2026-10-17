/*
 * H68（host.microscopy.importVolume）を実アプリで確かめる（fw/microscopy-cfm.md §5）。
 *
 * 実行:  cd automator && npx tsx src/spike/pluginMicroscopyCheck.ts
 *
 * 1. プラグインの JAR が自分の一時フォルダにチャネルを 2 本書く → H68 → 本体の確認画面 → OK で 2 シリーズの CFM が取り込まれ、一時ファイルが消える
 * 2. 確認を取り消すと何も取り込まれない
 * 3. 一時フォルダの外のパスを渡すと、本体が断る
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const PLUGIN_ID = "microscopy-check";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "plugin-microscopy");
const SRC_DIR = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
const SPI_JAR = path.join(AUTOMATOR_ROOT, "..", "backend", "target", "graphy-next-backend-plugin-api.jar");
const { check, summary } = createChecker();

function installPlugin(): void {
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const name of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(SRC_DIR, name), path.join(dst, name));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "microprobe-"));
  execFileSync("javac", ["--release", "17", "-cp", SPI_JAR, "-d", work, path.join(SRC_DIR, "java", "MicroscopyProbe.java")]);
  execFileSync("jar", ["--create", "--file", path.join(dst, "microscopy-probe.jar"), "-C", work, "."]);
  fs.rmSync(work, { recursive: true, force: true });
}

const spec = { width: 4, height: 3, slices: 2, phases: 1, type: "uint8", byteOrder: "little", offset: 0, spacing: [0.001, 0.001, 0.002] };

/** H68 を呼び、確認画面を押す。 */
async function importVia(page: Page, paths: string[], accept: boolean): Promise<{ ok: boolean; cancelled?: boolean; error?: string; imported: { seriesInstanceUid: string }[] }> {
  const req = { sourceName: "probe.lsm", sourceFormat: "Zeiss LSM", patient: { patientId: "H68-SPIKE" },
    channels: paths.map((p, i) => ({ path: p, spec, channelName: `Ch${i + 1}`, wavelengthNm: i === 0 ? 633 : null })) };
  const pr = page.evaluate(`window.__mainHost.microscopy.importVolume(${JSON.stringify(req)})`) as Promise<{ ok: boolean; cancelled?: boolean; error?: string; imported: { seriesInstanceUid: string }[] }>;
  await page.getByTestId("plugin-microscopy-consent").waitFor({ state: "visible", timeout: 20_000 });
  await page.screenshot({ path: path.join(OUT_DIR, `consent-${accept ? "ok" : "cancel"}-${Date.now()}.png`) });
  await page.getByTestId(accept ? "plugin-microscopy-consent-ok" : "plugin-microscopy-consent-cancel").click();
  return pr;
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();
  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    await resetDb(driver.ports.http);
    const base = `http://localhost:${driver.ports.http}`;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    await page.getByTestId("mainscreen-menu-plugins").click();
    await page.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
    await page.waitForFunction(() => !!(window as unknown as { __mainHost?: unknown }).__mainHost, null, { timeout: 20_000 });

    const job = async () => (await page.evaluate(`window.__mainHost.runBackendJob({})`)) as { ok: boolean; result: { paths: string[] } };

    // 1. 取り消すと何も取り込まない
    const j0 = await job();
    const cancelled = await importVia(page, j0.result.paths, false);
    const after0 = (await (await fetch(`${base}/api/studies`)).json()) as unknown[];
    check(cancelled.cancelled === true && after0.length === 0, `取り消すと何も取り込まない（検査 ${after0.length} 件）`, cancelled);

    // 2. OK で 2 シリーズ・一時ファイルが消える
    const j1 = await job();
    check(j1.ok && j1.result.paths.length === 2 && j1.result.paths.every((p) => fs.existsSync(p)), "プラグインのジョブが一時フォルダにチャネルを 2 本書く", j1);
    const done = await importVia(page, j1.result.paths, true);
    check(done.ok && done.imported.length === 2, `OK で 2 シリーズ取り込まれる（${done.imported.length}）`, done);
    check(j1.result.paths.every((p) => !fs.existsSync(p)), "取り込んだ一時ファイルは本体が消す");
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId: string }[];
    const st = studies.find((s) => s.patientId === "H68-SPIKE");
    const series = st ? ((await (await fetch(`${base}/api/studies/${st.studyInstanceUid}/series`)).json()) as { modality: string; seriesDescription: string }[]) : [];
    check(series.length === 2 && series.every((s) => s.modality === "CFM"), `1 検査に CFM のシリーズが 2 本（${series.map((s) => s.seriesDescription).join(",")}）`);

    // 3. 一時フォルダの外のパスは断られる
    const outside = path.join(OUT_DIR, "outside.raw");
    fs.writeFileSync(outside, Buffer.alloc(24));
    const bad = await importVia(page, [outside], true);
    check(!bad.ok && /一時フォルダ|temp/i.test(bad.error ?? "") && bad.imported.length === 0, `一時フォルダの外のパスは本体が断る（${bad.error}）`);
    check(fs.existsSync(outside), "断ったファイルは消さない");
  } finally {
    await driver.stop();
    fs.rmSync(path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID), { recursive: true, force: true });
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

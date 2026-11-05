/*
 * 実機確認用: 開発版の本体 + Computed DWI プラグインを起動し、GE 脳 DWI（b0・b1000）を取り込んで 2D ビューアを開いたまま待つ。
 * 実行: CDWI_GE=<b0/ b1000/ を持つフォルダ> npx tsx src/spike/transientDemo.ts   （Ctrl+C か、アプリを閉じて終了）
 * 専用のデータ置き場（automator/.results/run-data/desktop）を使うので、インストール済みアプリのデータには触れない。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { selectFirstStudy } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";

const GE = process.env.CDWI_GE!;
const PLUGIN_DIR = process.env.CDWI_PLUGIN_DIR ?? path.join(os.homedir(), "graphy-next-plugin-computed-dwi");
const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", "vis-computed-dwi");
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_DIR, n), path.join(dst, n));

const driver = new DesktopDriver({ http: 28741, scp: 28742, vite: 28743 });
await driver.start();
await resetDb(driver.ports.http);
await importPaths(driver.ports.http, [path.join(GE, "b0"), path.join(GE, "b1000")]);
const base = `http://localhost:${driver.ports.http}`;
const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
const series = (await (await fetch(`${base}/api/studies/${studies[0].studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string }[];
const page = driver.page;
await page.reload({ waitUntil: "domcontentloaded" });
await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
await selectFirstStudy(page, createStepRecorder());
await page.locator(`[data-testid="series-row-${series[0].seriesInstanceUid}"]`).click();
await page.getByTestId("series-viewer-root").waitFor({ state: "visible", timeout: 15_000 });
await page.waitForTimeout(1500);
const viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
console.log("READY: 2D ビューアが開きました。解析 → Computed DWI / vMRE から操作してください。");
await new Promise<void>((res) => { viewer.on("close", () => res()); page.on("close", () => res()); process.on("SIGINT", () => res()); });
await driver.stop().catch(() => undefined);

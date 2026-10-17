/*
 * Raw データ（ヘッダの無い画素配列）を非 DICOM 取り込みの画面から取り込み、値と幾何が申告どおりかを見る
 * （fw/nifti-import.md §8）。
 *
 * 実行:  cd automator && npx tsx src/spike/rawImportCheck.ts
 *
 * 1. 1 枚多く申告すると「足りません」が出て取込ボタンが押せない（押せないことを確かめる）
 * 2. 正しく申告すると「一致」になり、取り込むと 10 枚のシリーズができる
 * 3. 2D で開き、H10 のボリュームの患者座標の値が、作った Raw の値と一致する
 */
import fs from "node:fs";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "raw-import-check");
const PROBE_ID = "raw-import-probe";
const NX = 64;
const NY = 48;
const NZ = 10;
const OFFSET = 512;
const SPACING = [0.5, 0.5, 2.0];
const PATIENT_ID = "RAW-SPIKE";
const { check, summary } = createChecker();

const valueAt = (x: number, y: number, z: number): number => x * 37 - y * 11 + z * 1000 - 3000;

/** int16 リトルエンディアン。読み飛ばし領域の先頭は gzip のマジック（0x1F 0x8B）にしておく。 */
function writeRaw(file: string): void {
  const buf = Buffer.alloc(OFFSET + NX * NY * NZ * 2);
  buf[0] = 0x1f;
  buf[1] = 0x8b;
  let o = OFFSET;
  for (let z = 0; z < NZ; z++) for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
    buf.writeInt16LE(valueAt(x, y, z), o);
    o += 2;
  }
  fs.writeFileSync(file, buf);
}

const PROBE_UI = `
export async function activate(host) {
  const t = (host.getTargets() || []).find((x) => x.kind === "image");
  const vol = await host.loadVolume({ studyUid: t.studyUid, seriesUid: t.seriesUid });
  if (!vol) { window.__probe = { error: "loadVolume returned null" }; return; }
  const w = vol.worldToIndex;
  const [nx, ny] = vol.dims;
  const at = window.__probeSamples.map((s) => {
    const [x, y, z] = s.lps;
    const i = Math.round(w[0] * x + w[1] * y + w[2] * z + w[3]);
    const j = Math.round(w[4] * x + w[5] * y + w[6] * z + w[7]);
    const k = Math.round(w[8] * x + w[9] * y + w[10] * z + w[11]);
    return { ijk: [i, j, k], value: vol.data[i + nx * (j + ny * k)] };
  });
  window.__probe = { dims: vol.dims, at };
}
`;

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const raw = path.join(OUT_DIR, "phantom.raw");
  writeRaw(raw);
  // ボクセル（x, y, z）の中心の患者座標（軸位・原点 0）と、その答え
  const samples = [[0, 0, 0], [63, 0, 0], [0, 47, 0], [10, 20, 5], [63, 47, 9], [32, 24, 3]].map(([x, y, z]) => ({
    index: [x, y, z], lps: [x * SPACING[0], y * SPACING[1], z * SPACING[2]], value: valueAt(x, y, z),
  }));

  const probeDir = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PROBE_ID);
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(path.join(probeDir, "plugin.json"), JSON.stringify({ id: PROBE_ID, name: "Raw import probe", version: "0.0.1", contributes: ["viewer2d.menu"], ui: "ui.js" }));
  fs.writeFileSync(path.join(probeDir, "ui.js"), PROBE_UI);

  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    const base = `http://localhost:${driver.ports.http}`;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);

    // ── 画面から取り込む ──
    await page.screenshot({ path: path.join(OUT_DIR, "main.png") });
    await page.getByText(/^(非DICOM取込|Non-DICOM Import)$/).first().click();
    await page.getByTestId("raw-file-input").setInputFiles(raw);
    await page.getByTestId("raw-size-status").waitFor({ state: "visible", timeout: 10_000 });
    // 新しい患者として取り込む（患者 ID は紐付け先の欄）
    await page.getByText(/^(患者ID|Patient ID) \*$/).locator("xpath=..").locator("input").fill(PATIENT_ID);
    await page.getByTestId("raw-width").fill(String(NX));
    await page.getByTestId("raw-height").fill(String(NY));
    await page.getByTestId("raw-slices").fill(String(NZ + 1));
    await page.getByTestId("raw-offset").fill(String(OFFSET));
    await page.getByTestId("raw-spacing-x").fill(String(SPACING[0]));
    await page.getByTestId("raw-spacing-y").fill(String(SPACING[1]));
    await page.getByTestId("raw-spacing-z").fill(String(SPACING[2]));
    await page.getByTestId("raw-modality").selectOption("CT");
    const runBtn = page.getByTestId("nondicom-run");
    await page.waitForFunction(() => /(足りません|missing)/.test(document.querySelector('[data-testid="raw-size-status"]')?.textContent ?? ""), null, { timeout: 10_000 });
    const shortText = await page.getByTestId("raw-size-status").innerText();
    check(/(足りません|missing)/.test(shortText) && (await runBtn.isDisabled()), "1 枚多く申告すると「足りません」が出て取込ボタンが押せない", shortText);
    await page.screenshot({ path: path.join(OUT_DIR, "dialog-short.png") });

    await page.getByTestId("raw-slices").fill(String(NZ));
    await page.waitForFunction(() => /(一致|matches)/.test(document.querySelector('[data-testid="raw-size-status"]')?.textContent ?? ""), null, { timeout: 10_000 });
    check(await runBtn.isEnabled(), "正しく申告すると「一致」になり取込ボタンが押せる", await page.getByTestId("raw-size-status").innerText());
    await page.screenshot({ path: path.join(OUT_DIR, "dialog-exact.png") });
    await runBtn.click();
    await page.getByTestId("raw-summary").waitFor({ state: "visible", timeout: 60_000 });
    const sumText = await page.getByTestId("raw-summary").innerText();
    check(new RegExp(`(${NZ} 枚|${NZ} images)`).test(sumText), `取り込みの結果が出る（${sumText}）`);
    await page.screenshot({ path: path.join(OUT_DIR, "dialog-done.png") });
    await page.getByLabel(/^(閉じる|Close)$/).first().click().catch(() => undefined);

    // ── 一覧と幾何 ──
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId: string }[];
    const st = studies.find((s) => s.patientId === PATIENT_ID);
    check(!!st, "取り込んだ検査が一覧（API）にある", studies);
    if (!st) return;
    const series = (await (await fetch(`${base}/api/studies/${st.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; numberOfInstances?: number; modality?: string }[];
    const se = series[0];
    const lay = (await (await fetch(`${base}/api/studies/${st.studyInstanceUid}/series/${se.seriesInstanceUid}/layout`)).json()) as { nZ: number; imageWidth: number; imageHeight: number; imageOrientationPatient?: number[] };
    check(lay.nZ === NZ && lay.imageWidth === NX && lay.imageHeight === NY, `レイアウト ${lay.imageWidth}×${lay.imageHeight}×${lay.nZ}`, lay);
    check(JSON.stringify(lay.imageOrientationPatient) === JSON.stringify([1, 0, 0, 0, 1, 0]), "IOP は軸位", lay.imageOrientationPatient);

    // ── 2D で開いて値を見る ──
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${st.studyInstanceUid}"]`).click();
    await page.locator(`[data-testid="series-row-${se.seriesInstanceUid}"]`).click();
    const viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
    await viewer.waitForTimeout(3_000);
    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer.png") });
    await viewer.evaluate((s) => { Object.assign(window, { __probeSamples: s }); }, samples);
    await viewer.getByTestId("viewer2d-menu-plugins").click();
    await viewer.getByTestId(`plugin-item-${PROBE_ID}`).click();
    await viewer.waitForFunction(() => !!(window as unknown as { __probe?: unknown }).__probe, null, { timeout: 60_000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = await viewer.evaluate(() => (window as unknown as { __probe: unknown }).__probe);
    fs.writeFileSync(path.join(OUT_DIR, "probe.json"), JSON.stringify(p, null, 1));
    check(!p.error && p.dims.join("x") === `${NX}x${NY}x${NZ}`, `H10 の格子 ${p.dims?.join("×")}`, p.error);
    if (!p.error) {
      samples.forEach((s, i) => {
        check(p.at[i].value === s.value && p.at[i].ijk.join(",") === s.index.join(","),
          `ボクセル ${s.index.join(",")}（LPS ${s.lps.join(",")} mm）: H10 ${p.at[i].value} = 作った値 ${s.value}`, p.at[i]);
      });
    }
  } finally {
    await driver.stop();
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

/*
 * ANALYZE 7.5（.hdr＋.img）を非DICOM取込の画面から取り込む（fw/nifti-import.md §9）。
 *
 * 実行:  cd automator && npx tsx src/spike/analyzeImportCheck.ts
 *
 * 1. .hdr と .img を両方選んでも 1 本にまとまり、ANALYZE と合成の向きの警告が出る
 * 2. 取り込むと 2D で開け、H10 のボリュームの値が作った値と一致する
 */
import fs from "node:fs";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "analyze-import-check");
const PROBE_ID = "analyze-import-probe";
const NX = 16;
const NY = 12;
const NZ = 4;
const PATIENT_ID = "ANALYZE-SPIKE";
const { check, summary } = createChecker();
const valueAt = (x: number, y: number, z: number): number => x * 5 - y * 3 + z * 100;

function writeAnalyze(stem: string): void {
  const h = Buffer.alloc(348);
  h.writeInt32LE(348, 0);
  [3, NX, NY, NZ, 1, 0, 0, 0].forEach((v, i) => h.writeInt16LE(v, 40 + i * 2));
  h.writeInt16LE(4, 70); // int16
  h.writeInt16LE(16, 72);
  [1, 1, 1, 2.5, 0, 0, 0, 0].forEach((v, i) => h.writeFloatLE(v, 76 + i * 4));
  h[252] = 1; // orient（使わないことを確かめる）
  fs.writeFileSync(`${stem}.hdr`, h);
  const img = Buffer.alloc(NX * NY * NZ * 2);
  let o = 0;
  for (let z = 0; z < NZ; z++) for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) { img.writeInt16LE(valueAt(x, y, z), o); o += 2; }
  fs.writeFileSync(`${stem}.img`, img);
}

const PROBE_UI = `
export async function activate(host) {
  const t = (host.getTargets() || []).find((x) => x.kind === "image");
  const vol = await host.loadVolume({ studyUid: t.studyUid, seriesUid: t.seriesUid });
  if (!vol) { window.__probe = { error: "loadVolume returned null" }; return; }
  const w = vol.worldToIndex;
  const m = vol.indexToWorld;
  const [nx, ny] = vol.dims;
  // 合成の向きは行 −x・列 −y。ボクセル (i,j,k) の中心を index→world→index と往復させずに、本体の幾何でボクセルの値を読む
  const at = window.__probeSamples.map((s) => {
    const [i0, j0, k0] = s.index;
    const p = [m[0] * i0 + m[1] * j0 + m[2] * k0 + m[3], m[4] * i0 + m[5] * j0 + m[6] * k0 + m[7], m[8] * i0 + m[9] * j0 + m[10] * k0 + m[11]];
    const i = Math.round(w[0] * p[0] + w[1] * p[1] + w[2] * p[2] + w[3]);
    const j = Math.round(w[4] * p[0] + w[5] * p[1] + w[6] * p[2] + w[7]);
    const k = Math.round(w[8] * p[0] + w[9] * p[1] + w[10] * p[2] + w[11]);
    return { ijk: [i, j, k], lps: p, value: vol.data[i + nx * (j + ny * k)] };
  });
  window.__probe = { dims: vol.dims, at };
}
`;

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stem = path.join(OUT_DIR, "brain");
  writeAnalyze(stem);
  const samples = [[0, 0, 0], [15, 0, 0], [0, 11, 0], [7, 5, 2], [15, 11, 3]].map(([x, y, z]) => ({ index: [x, y, z], value: valueAt(x, y, z) }));

  const probeDir = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PROBE_ID);
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(path.join(probeDir, "plugin.json"), JSON.stringify({ id: PROBE_ID, name: "ANALYZE import probe", version: "0.0.1", contributes: ["viewer2d.menu"], ui: "ui.js" }));
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

    await page.getByText(/^(非DICOM取込|Non-DICOM Import)$/).first().click();
    await page.locator('input[type="file"][multiple]').first().setInputFiles([`${stem}.hdr`, `${stem}.img`]);
    await page.getByTestId("nifti-unit").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(() => /ANALYZE/.test(document.body.innerText), null, { timeout: 15_000 });
    const body = await page.locator("body").innerText();
    const listed = (body.match(/brain\.(hdr|img)/g) ?? []).length;
    check(/\[ANALYZE\]/.test(body), "下読みに [ANALYZE] と出る");
    check(/ANALYZE 7\.5/.test(body), "ANALYZE の合成の向きの警告が出る");
    await page.screenshot({ path: path.join(OUT_DIR, "dialog.png") });
    await page.getByText(/^(患者ID|Patient ID) \*$/).locator("xpath=..").locator("input").fill(PATIENT_ID);
    await page.getByTestId("nondicom-run").click();
    await page.waitForFunction(() => /(枚を取り込みました|imported)/i.test(document.body.innerText), null, { timeout: 60_000 });
    await page.screenshot({ path: path.join(OUT_DIR, "dialog-done.png") });
    await page.getByLabel(/^(閉じる|Close)$/).first().click();

    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId: string }[];
    const st = studies.filter((s) => s.patientId === PATIENT_ID);
    check(st.length === 1, `.hdr と .img を両方選んでも 1 検査だけ取り込まれる（${st.length} 件）`, { listed, st });
    if (st.length === 0) return;
    const series = (await (await fetch(`${base}/api/studies/${st[0].studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string }[];
    check(series.length === 1, `シリーズは 1 本（${series.length}）`);
    const se = series[0];

    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${st[0].studyInstanceUid}"]`).click();
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
      samples.forEach((s, i) => check(p.at[i].value === s.value, `ボクセル ${s.index.join(",")}: H10 ${p.at[i].value} = 作った値 ${s.value}`, p.at[i]));
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

/*
 * CT 定量の真値照合（fw/ct-quant-design.md §7・Q4）。合成 CT を本体に取り込み、H10 → H66 の経路で測った値を
 * 解析的な真値（直方体の大きさ × 間隔）と突き合わせる。Colab は使わない。
 *
 * 実行:  cd automator && npx tsx src/spike/ctQuantPhantomCheck.ts
 *        （ファントムの生成に pydicom・numpy のある Python が要る: GRAPHY_TEST_PYTHON、既定は python）
 *
 * ラベルは CT 値の一致で作る（幾何に頼らない）。校正（傾き 2・切片 −1024）を誤ると CT 値が一致せず、
 * ラベルが空になって落ちる＝負例が組み込まれている。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "ct-quant-phantom-check");
const PHANTOM_DIR = path.join(OUT_DIR, "phantom");
const PROBE_ID = "ct-quant-phantom-probe";
const { check, summary } = createChecker();

/** H10 で読み、CT 値の一致でラベルを作って H66 で測るだけのプラグイン。 */
const PROBE_UI = `
export async function activate(host) {
  const cfg = window.__probeConfig;
  const t = (host.getTargets() || []).find((x) => x.kind === "image");
  const vol = await host.loadVolume({ studyUid: t.studyUid, seriesUid: t.seriesUid });
  const names = Object.keys(cfg.values);
  const lab = new Uint8Array(vol.data.length);
  for (let p = 0; p < vol.data.length; p++) {
    const v = vol.data[p];
    for (let n = 0; n < names.length; n++) if (cfg.values[names[n]].includes(v)) { lab[p] = n + 1; break; }
  }
  const w = vol.worldToIndex;
  const [x, y, z] = cfg.sliceWorld;
  const k = Math.round(w[8] * x + w[9] * y + w[10] * z + w[11]);
  const res = host.measureLabels({ data: lab, dims: vol.dims, indexToWorld: vol.indexToWorld }, vol, {
    erodeVoxels: 1, slices: [k],
    valueRanges: [{ name: "muscle", min: -29, max: 150 }, { name: "fat", min: -190, max: -30 }],
  });
  window.__probe = { names, k, unit: vol.unit, dims: vol.dims, spacing: vol.spacing, res };
}
`;

const near = (a: number, b: number, rel = 1e-6) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(b));

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const py = process.env.GRAPHY_TEST_PYTHON ?? "python";
  const gen = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", "make-ct-quant-phantom.py"), PHANTOM_DIR], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`ファントムを作れませんでした: ${gen.stderr}`);
  const truth = JSON.parse(fs.readFileSync(path.join(PHANTOM_DIR, "truth.json"), "utf8"));
  fs.renameSync(path.join(PHANTOM_DIR, "truth.json"), path.join(OUT_DIR, "truth.json"));

  const probeDir = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PROBE_ID);
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(path.join(probeDir, "plugin.json"), JSON.stringify({ id: PROBE_ID, name: "CT quant phantom probe", version: "0.0.1", contributes: ["viewer2d.menu"], ui: "ui.js" }));
  fs.writeFileSync(path.join(probeDir, "ui.js"), PROBE_UI);

  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [PHANTOM_DIR]);
    console.log(`    取り込み: ${JSON.stringify(imp).slice(0, 200)}`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${truth.studyUid}"]`).click();
    await page.locator(`[data-testid="series-row-${truth.seriesUid}"]`).click();
    const viewer = await driver.waitForNewPage(
      () => page.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(2_000);

    // mixed の真ん中のスライス（k=30）を患者座標で渡す（並び順に頼らない）
    const values: Record<string, number[]> = {};
    for (const [n, b] of Object.entries(truth.boxes as Record<string, { values: number[] }>)) values[n] = b.values;
    const sliceWorld = [-50, -40, 100 + 30 * truth.spacingMm.slice];
    await viewer.evaluate((cfg) => { (window as unknown as { __probeConfig: unknown }).__probeConfig = cfg; }, { values, sliceWorld });
    await viewer.getByTestId("viewer2d-menu-plugins").click();
    await viewer.getByTestId(`plugin-item-${PROBE_ID}`).click();
    await viewer.waitForFunction(() => !!(window as unknown as { __probe?: unknown }).__probe, null, { timeout: 60_000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const probe: any = await viewer.evaluate(() => (window as unknown as { __probe: unknown }).__probe);
    fs.writeFileSync(path.join(OUT_DIR, "measured.json"), JSON.stringify(probe, null, 1));

    console.log("\n[1] 前提: 校正と格子");
    check(probe.unit === "HU", "単位が HU", probe.unit);
    check(probe.dims.join("x") === "128x112x40", "格子 128 × 112 × 40", probe.dims);
    check(near(probe.spacing[0], 0.7) && near(probe.spacing[1], 0.8) && near(probe.spacing[2], 2.5), "間隔 列 0.7・行 0.8・スライス 2.5 mm", probe.spacing);
    check(probe.k === 30, "患者座標から選んだスライスが k=30", probe.k);
    const byName = new Map<string, any>(probe.names.map((n: string, i: number) => [n, probe.res.find((r: { label: number }) => r.label === i + 1)]));
    check(probe.names.every((n: string) => byName.get(n)), "4 つの直方体すべてが CT 値の一致で見つかる（校正の傾き 2 が効いている）", probe.res.map((r: { label: number }) => r.label));

    console.log("\n[2] 真値との照合（真値は直方体の大きさ × 間隔から）");
    for (const [n, b] of Object.entries(truth.boxes as Record<string, any>)) {
      const r = byName.get(n);
      if (!r) continue;
      check(near(r.volumeMl, b.volumeMl), `${n}: 体積 ${r.volumeMl.toFixed(4)} mL = 真値 ${b.volumeMl.toFixed(4)} mL`);
      check(near(r.stats.mean, b.meanHu, 1e-5), `${n}: 平均 ${r.stats.mean.toFixed(3)} HU = 真値 ${b.meanHu.toFixed(3)} HU`);
      check(r.eroded.n === b.erodedVoxels, `${n}: 境界を除いたボクセル数 ${r.eroded.n} = ${b.erodedVoxels}`);
      const inSlice = probe.k >= b.k[0] && probe.k < b.k[1];
      const s = r.slices[0];
      check(near(s.areaCm2, inSlice ? b.sliceAreaCm2 : 0), `${n}: k=30 の面積 ${s.areaCm2.toFixed(4)} cm² = 真値 ${(inSlice ? b.sliceAreaCm2 : 0).toFixed(4)} cm²`);
      if (n === "mixed") {
        check(near(s.rangeAreasCm2.muscle, b.muscleAreaCm2), `mixed: 筋の範囲の面積 ${s.rangeAreasCm2.muscle.toFixed(4)} = 真値 ${b.muscleAreaCm2.toFixed(4)} cm²`);
        check(near(s.rangeAreasCm2.fat, b.fatAreaCm2), `mixed: 脂肪の範囲の面積 ${s.rangeAreasCm2.fat.toFixed(4)} = 真値 ${b.fatAreaCm2.toFixed(4)} cm²`);
      }
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

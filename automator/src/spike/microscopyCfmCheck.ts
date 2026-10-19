/*
 * 顕微鏡（LSM）を CFM（32 ビット・規格外）で取り込み、2D・MPR で開き、値と注記・送信前の確認を見る（fw/microscopy-cfm.md）。
 *
 * 実行:  cd automator && GRAPHY_TEST_PYTHON=<tifffile のある python> npx tsx src/spike/microscopyCfmCheck.ts
 * 実データ: ~/graphy-workspace/open-testdata/lsm/Lan_Larval_Chitin_DMSO_control_01.lsm（Zenodo 16916709・CC BY 4.0。リポジトリには入れない）
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "microscopy-cfm-check");
const PROBE_ID = "cfm-probe";
const LSM = process.env.GRAPHY_TEST_LSM ?? path.join(os.homedir(), "graphy-workspace", "open-testdata", "lsm", "Lan_Larval_Chitin_DMSO_control_01.lsm");
const PATIENT_ID = "LSM-SPIKE";
const { check, summary } = createChecker();

// LSM をチャネルごとの Raw にし、答え（いくつかのボクセルの値）と寸法を JSON に出す
const DUMP = `
import sys, json, tifffile, numpy as np
src, out = sys.argv[1], sys.argv[2]
with tifffile.TiffFile(src) as t:
    a = t.series[0].asarray(); m = t.lsm_metadata
nz, nc, ny, nx = a.shape
for c in range(nc):
    a[:, c].astype('<u1').tofile(f"{out}/ch{c}.raw")
# 背景（0）ばかりだと照合にならないので、値の大きい点と、0 でない点を決まった順で選ぶ
ch0 = a[:, 0]
z, y, x = np.unravel_index(int(np.argmax(ch0)), ch0.shape)
nzp = np.argwhere(ch0 > 0)
pick = nzp[np.linspace(0, len(nzp) - 1, 4).astype(int)]
pts = [[int(x), int(y), int(z)]] + [[int(p[2]), int(p[1]), int(p[0])] for p in pick] + [[0, 0, 0]]
print(json.dumps({"nx":nx,"ny":ny,"nz":nz,"nc":nc,"vx":m["VoxelSizeX"]*1000,"vy":m["VoxelSizeY"]*1000,"vz":m["VoxelSizeZ"]*1000,
  "samples":[{"index":p,"value":float(a[p[2],0,p[1],p[0]])} for p in pts]}))
`;

const PROBE_UI = `
export async function activate(host) {
  const t = (host.getTargets() || []).find((x) => x.kind === "image");
  const vol = await host.loadVolume({ studyUid: t.studyUid, seriesUid: t.seriesUid });
  if (!vol) { window.__probe = { error: "loadVolume returned null" }; return; }
  const m = vol.indexToWorld, w = vol.worldToIndex;
  const [nx, ny] = vol.dims;
  const at = window.__probeSamples.map((s) => {
    const [i0, j0, k0] = s.index;
    const p = [m[0]*i0+m[1]*j0+m[2]*k0+m[3], m[4]*i0+m[5]*j0+m[6]*k0+m[7], m[8]*i0+m[9]*j0+m[10]*k0+m[11]];
    const i = Math.round(w[0]*p[0]+w[1]*p[1]+w[2]*p[2]+w[3]);
    const j = Math.round(w[4]*p[0]+w[5]*p[1]+w[6]*p[2]+w[7]);
    const k = Math.round(w[8]*p[0]+w[9]*p[1]+w[10]*p[2]+w[11]);
    return { ijk: [i, j, k], value: vol.data[i + nx * (j + ny * k)] };
  });
  window.__probe = { dims: vol.dims, at, step: [m[2], m[6], m[10]] };
}
`;

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(LSM)) throw new Error(`LSM がありません: ${LSM}`);
  const dump = spawnSync(process.env.GRAPHY_TEST_PYTHON ?? "python3", ["-c", DUMP, LSM, OUT_DIR], { encoding: "utf8" });
  if (dump.status !== 0) throw new Error(`LSM を読めません: ${dump.stderr}`);
  const meta = JSON.parse(dump.stdout);

  const probeDir = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PROBE_ID);
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(path.join(probeDir, "plugin.json"), JSON.stringify({ id: PROBE_ID, name: "CFM probe", version: "0.0.1", contributes: ["viewer2d.menu"], ui: "ui.js" }));
  fs.writeFileSync(path.join(probeDir, "ui.js"), PROBE_UI);

  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    const dialogs: string[] = [];
    page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await resetDb(driver.ports.http);
    const base = `http://localhost:${driver.ports.http}`;
    let study: string | undefined; let forUid: string | undefined; let specimen: string | undefined;
    const series: string[] = [];
    for (let c = 0; c < meta.nc; c++) {
      const res = await fetch(`${base}/api/microscopy/import`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path.join(OUT_DIR, `ch${c}.raw`), spec: { width: meta.nx, height: meta.ny, slices: meta.nz, phases: 1, type: "uint8", byteOrder: "little", offset: 0, spacing: [meta.vx, meta.vy, meta.vz], orientation: "axial" },
          channelName: `Ch${c + 1}`, sourceFormat: "Zeiss LSM", sourceName: path.basename(LSM), patientId: PATIENT_ID, seriesNumber: c + 1,
          studyInstanceUid: study, frameOfReferenceUid: forUid, specimenUid: specimen }),
      });
      const r = (await res.json()) as { studyInstanceUid: string; seriesInstanceUid: string; frameOfReferenceUid: string; specimenUid: string; frames: number; error: string | null };
      check(res.ok && r.frames === meta.nz, `チャネル ${c + 1} を CFM で取り込む（${r.frames} フレーム）`, r);
      study = r.studyInstanceUid; forUid = r.frameOfReferenceUid; specimen = r.specimenUid; series.push(r.seriesInstanceUid);
    }
    const lay = (await (await fetch(`${base}/api/studies/${study}/series/${series[0]}/layout`)).json()) as { nZ: number; zSpatial: { imagePositionPatient: number[] }[] };
    const step = lay.zSpatial[1].imagePositionPatient[2] - lay.zSpatial[0].imagePositionPatient[2];
    check(lay.nZ === meta.nz && Math.abs(step - meta.vz) < 1e-9, `layout: ${lay.nZ} 枚・Z の間隔 ${step} mm（LSM ${meta.vz} mm）`);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${study}"]`).click();
    await page.locator(`[data-testid="series-row-${series[0]}"]`).click();

    // 書き出し: CFM を含むので規格外の確認が出る（閉じる＝取り消し）
    await page.getByText(/^(エクスポート|Export)$/).first().click();
    await page.getByTestId("export-run").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(1500);
    await page.getByTestId("export-run").click();
    await page.waitForTimeout(1000);
    check(dialogs.some((m) => /CFM/.test(m) && /(規格|standard)/.test(m)), "書き出しの前に、CFM が規格外である確認が出る", dialogs);
    await page.screenshot({ path: path.join(OUT_DIR, "export.png") });
    await page.getByLabel(/^(閉じる|Close)$/).first().click().catch(() => undefined);

    // 2D
    const viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
    await viewer.waitForTimeout(3000);
    await viewer.getByTestId("viewer-info-toggle").first().click();
    await viewer.getByTestId("info-cfm-note").first().waitFor({ state: "visible", timeout: 10_000 });
    check(/スライド座標|slide coordinates/i.test(await viewer.getByTestId("info-cfm-note").first().innerText()), "情報欄に「スライド座標」の注記が出る");
    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer.png") });
    await viewer.evaluate((s) => { Object.assign(window, { __probeSamples: s }); }, meta.samples);
    await viewer.getByTestId("viewer2d-menu-plugins").click();
    await viewer.getByTestId(`plugin-item-${PROBE_ID}`).click();
    await viewer.waitForFunction(() => !!(window as unknown as { __probe?: unknown }).__probe, null, { timeout: 60_000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = await viewer.evaluate(() => (window as unknown as { __probe: unknown }).__probe);
    fs.writeFileSync(path.join(OUT_DIR, "probe.json"), JSON.stringify(p, null, 1));
    check(!p.error && p.dims.join("x") === `${meta.nx}x${meta.ny}x${meta.nz}`, `H10 の格子 ${p.dims?.join("×")}`, p.error);
    if (!p.error) {
      check(meta.samples.filter((s: { value: number }) => s.value > 0).length >= 4, "照合する点の多くが 0 でない（背景だけを見ていない）", meta.samples);
      meta.samples.forEach((s: { index: number[]; value: number }, i: number) =>
        check(p.at[i].value === s.value, `ボクセル ${s.index.join(",")}: H10 ${p.at[i].value} = LSM ${s.value}`, p.at[i]));
    }

    // MPR: ボクセルが描画の最小のスラブより細かいので、理由を出して止める（組んで黒く描くより正しい）
    const mpr = await driver.waitForNewPage(() => page.locator('button[title="MPR Viewer"]').click(), (url) => url.includes("mpr"));
    await mpr.waitForTimeout(6000);
    const mprText = await mpr.evaluate(() => document.body.innerText);
    check(/(細かすぎる|too fine)/i.test(mprText), "MPR は「ボクセルが細かすぎる」と理由を出す", mprText.slice(0, 300));
    await mpr.screenshot({ path: path.join(OUT_DIR, "mpr.png") });
    await mpr.close();

    // 3D: 実際に開いて描けるかを見る（決めつけない）
    const v3d = await driver.waitForNewPage(() => page.locator('button[title="3D Viewer"]').click(), (url) => url.includes("viewer3d"));
    await v3d.waitForTimeout(12000);
    const v3dText = await v3d.evaluate(() => document.body.innerText);
    const lum3d = await v3d.evaluate(() => {
      let best = 0;
      for (const c of Array.from(document.querySelectorAll("canvas")) as HTMLCanvasElement[]) {
        const g = c.getContext("2d");
        if (!g || c.width === 0) continue;
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const hist = new Set<number>();
        for (let i = 0; i < d.length; i += 16) hist.add(Math.round((d[i] + d[i + 1] + d[i + 2]) / 3));
        best = Math.max(best, hist.size);
      }
      return best;
    });
    check(/(細かすぎる|too fine)/i.test(v3dText), "3D も「ボクセルが細かすぎる」と理由を出す（試すと真っ黒だった）", { lum3d, text: v3dText.slice(0, 200) });
    await v3d.screenshot({ path: path.join(OUT_DIR, "viewer3d.png") });
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

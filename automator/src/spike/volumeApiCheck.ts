/*
 * H10（ボリューム＋患者座標の読み出し）・H21（位置合わせ／リサンプル）・H28（多フレーム NM の展開）の
 * 実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/volumeApiCheck.ts
 *
 * <p><b>何を確かめるか</b>（本物の Electron ＋ backend ＋ プラグイン配信経路）:
 *
 *   1. H28: 多フレーム NM（SPECT）が **48 スライスのシリーズとして開く**（従来は 1 枚だった）
 *   2. H28: 展開したフレームが**患者座標を持つ**（NM は per-frame の IPP を持たないので本体が作る）
 *   3. H10: `loadVolume` がシリーズ丸ごとを**校正済み値＋患者 LPS の幾何**で返す
 *   4. H10: `studyUid` 省略時は開いているタイルから解決し、**開いていないシリーズは読めない**
 *   5. H21: `registerVolumes` が本体の実装で走る（同一シリーズ同士なら移動量ゼロ）
 *   6. H21: `resampleVolume` が別格子へ引き直す（値が真値と一致し、範囲外は NaN）
 *
 * <p>真値はファントム GNBP-D（線量評価プラグインの `bench/`）。生成物が無ければ作り方を出して終わる。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const PLUGIN_ID = "volumeapi-check";
const PLUGIN_SRC = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
const PHANTOM = path.join(
  os.homedir(), "graphy-workspace", "graphy-next-plugin-dosimetry", "bench", "phantom", "GNBP-D",
);
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "volume-api-check");

const failures: string[] = [];
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
function near(got: number, want: number, tol: number, label: string): void {
  check(Number.isFinite(got) && Math.abs(got - want) <= tol, `${label}（期待 ${want} / 実測 ${got}）`);
}

interface Probe {
  error: string | null;
  steps: { step: string; value: unknown }[];
  ptVolume?: VolumeSummary | null;
  ctVolume?: VolumeSummary | null;
  resampled?: VolumeSummary | null;
  ptLiverValue?: { index: number[]; value: number } | null;
  ctLiverValue?: { index: number[]; value: number } | null;
  resampledLiverValue?: { index: number[]; value: number } | null;
  resampledOutside?: { index: number[]; value: number } | null;
  resolvedWithoutStudyUid?: boolean;
  unknownSeries?: unknown;
  registration?: {
    translationMm: number[];
    eulerDeg: number[];
    metricValue: number;
    elapsedMs: number;
    aborted: boolean;
    hasDeformation: boolean;
  } | null;
}
interface VolumeSummary {
  dims: number[];
  spacing: number[];
  ipp: number[];
  iop: number[];
  modality: string;
  unit: string;
  sliceThickness: number | null;
  frameOfReferenceUid: string | null;
  length: number;
  finite: number;
}

function installPlugin(): void {
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ["plugin.json", "ui.js"]) {
    fs.copyFileSync(path.join(PLUGIN_SRC, f), path.join(dst, f));
  }
  console.log(`プラグインを配置: ${dst}`);
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(PHANTOM, "dicom"))) {
    console.error(`ファントムがありません: ${PHANTOM}/dicom`);
    console.error("  cd ~/graphy-workspace/graphy-next-plugin-dosimetry && npm run phantom:dicom");
    process.exit(1);
  }
  const truth = JSON.parse(fs.readFileSync(path.join(PHANTOM, "truth.json"), "utf-8"));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();

  const driver = new DesktopDriver();
  await driver.start();
  let viewer: Page | null = null;
  try {
    const http = driver.ports.http;
    console.log(`\n[0] 初期化（backend=${http}）`);
    console.log(`  reset: ${JSON.stringify(await resetDb(http))}`);
    const dirs = fs.readdirSync(path.join(PHANTOM, "dicom")).map((d) => path.join(PHANTOM, "dicom", d));
    const res = await fetch(`http://127.0.0.1:${http}/api/import/paths`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: dirs }),
    });
    console.log(`  import: ${JSON.stringify(await res.json())}`);

    // --- H28: シリーズのレイアウトを backend に直接聞く ---------------------
    console.log("\n[1] H28: 多フレーム NM がスライスとして展開されるか（backend のレイアウト）");
    const tp0 = truth.timepoints[0];
    const layoutUrl = (seriesUid: string) =>
      `http://127.0.0.1:${http}/api/studies/${tp0.studyUid}/series/${seriesUid}/layout`;
    const nmLayout = (await (await fetch(layoutUrl(tp0.nm.dicom))).json()) as {
      nZ: number; nC: number; nT: number; cells: { z: number; frame: number }[];
      zSpatial: { z: number; imagePositionPatient: number[] }[] | null;
      pixelSpacingRow: number; imageOrientationPatient: number[] | null;
    };
    check(nmLayout.nZ === truth.geometry.nm.slices, `★ NM が ${truth.geometry.nm.slices} スライスに展開される`, nmLayout.nZ);
    check(nmLayout.nT === 1, "位相は 1（ゲート収集ではない）", nmLayout.nT);
    check(nmLayout.cells.length === truth.geometry.nm.slices, "セル数＝フレーム数", nmLayout.cells.length);
    check(!!nmLayout.zSpatial && nmLayout.zSpatial.length === truth.geometry.nm.slices,
      "★ 各スライスに患者座標が付く（NM は per-frame の IPP を持たないので本体が作る）",
      nmLayout.zSpatial?.length);
    if (nmLayout.zSpatial) {
      const sp = truth.geometry.nm.spacingMm[2] as number;
      const z0 = nmLayout.zSpatial[0].imagePositionPatient[2];
      const z1 = nmLayout.zSpatial[1].imagePositionPatient[2];
      near(z1 - z0, sp, 1e-6, "★ スライス間隔が SpacingBetweenSlices と一致");
      near(z0, -((truth.geometry.nm.slices - 1) / 2) * sp, 1e-6, "先頭スライスの z");
    }
    near(nmLayout.pixelSpacingRow, truth.geometry.nm.spacingMm[0], 1e-9, "画素間隔");

    // 切り出したフレームが単一フレーム DICOM として取れること。
    const frameUrl = `http://127.0.0.1:${http}/api/studies/${tp0.studyUid}/series/${tp0.nm.dicom}/instances/${await firstSop(http, tp0.studyUid, tp0.nm.dicom)}/frames/28/file`;
    const frameRes = await fetch(frameUrl);
    check(frameRes.ok, "★ NM のフレームが単一フレーム DICOM として取れる", frameRes.status);
    const bytes = new Uint8Array(await frameRes.arrayBuffer());
    check(bytes.length > 1000, "フレームの中身がある", bytes.length);

    // --- 画面を開いてプラグインを走らせる -----------------------------------
    console.log("\n[2] 2D Viewer を開く");
    const main = driver.page;
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await main.locator('input[type="date"]').nth(0).fill("");
    await main.locator('input[type="date"]').nth(1).fill("");
    await main.getByTestId("search-patientid-input").fill("GNBP-D-1");
    await main.getByTestId("search-submit-button").click();
    await main.waitForTimeout(2500);
    await main.getByTestId(`study-row-${tp0.studyUid}`).click();
    await main.waitForTimeout(1200);
    await main.getByTestId(`series-row-${tp0.spect.dicom}`).click();
    await main.getByTestId("series-viewer-root").waitFor({ state: "visible", timeout: 20_000 });
    await main.waitForTimeout(1500);
    viewer = await driver.waitForNewPage(
      () => main.getByTestId("viewer2d-toolbar-button").click(),
      (url: string) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2000);

    // CT と NM のタイルも足す（左ツリーの「＋」）。
    for (const label of ["CT CT 4h", "NM SPECT 4h"]) {
      const clicked = await viewer.evaluate(`
        (function (needle) {
          var all = document.querySelectorAll("div");
          for (var i = 0; i < all.length; i++) {
            var t = all[i].textContent || "";
            if (t.length > 80 || t.indexOf(needle) < 0) continue;
            var b = all[i].querySelector("button");
            var mark = b ? (b.textContent || "").trim() : "";
            if (b && !b.disabled && (mark === "＋" || mark === "+")) { b.click(); return true; }
          }
          return false;
        })(${JSON.stringify(label)})
      `);
      check(clicked === true, `左ツリーから「${label}」をタイルに追加できる`);
      await viewer.waitForTimeout(2000);
    }

    // H28（画面側）: NM のタイルがスライス 48 枚として見えるか。
    const nmTarget = await viewer.evaluate(`
      (function () {
        var el = document.querySelectorAll('[data-testid="viewer2d-canvas-host"]');
        return el.length;
      })()
    `);
    check(nmTarget === 3, "タイルが 3 枚（PT / CT / NM）", nmTarget);

    console.log("\n[3] プラグイン（H10 / H21）を実行する");
    await viewer.getByTestId("viewer2d-menu-plugins").click();
    const item = viewer.getByTestId(`plugin-item-${PLUGIN_ID}`);
    check((await item.count()) > 0, "プローブが Plug-ins メニューに出る");
    await item.first().click();
    for (let i = 0; i < 300; i++) {
      const done = await viewer.evaluate(`Boolean(window.__volumeApiCheck)`);
      if (done) break;
      await viewer.waitForTimeout(1000);
    }
    const probe = (await viewer.evaluate(`window.__volumeApiCheck ?? null`)) as Probe | null;
    fs.writeFileSync(path.join(OUT_DIR, "probe.json"), JSON.stringify(probe, null, 2));
    check(!!probe, "プローブが結果を返す");
    if (!probe) throw new Error("probe が動いていない");
    check(probe.error === null, "プローブが例外なく終わる", probe.error);

    const targets = (probe.steps.find((s) => s.step === "targets")?.value ?? []) as {
      modality: string; sliceCount: number; label: string;
    }[];
    const nmTile = targets.find((t) => t.modality === "NM");
    check(!!nmTile, "NM のタイルが開いている");
    check(nmTile?.sliceCount === truth.geometry.nm.slices,
      `★ 画面から見ても NM は ${truth.geometry.nm.slices} スライス（H28 の本丸）`, nmTile?.sliceCount);

    console.log("\n[4] H10 の中身を真値と突き合わせる");
    const pt = probe.ptVolume;
    check(!!pt, "SPECT のボリュームが読める");
    if (pt) {
      const g = truth.geometry.spect;
      check(JSON.stringify(pt.dims) === JSON.stringify([g.cols, g.rows, g.slices]), "★ 次元", pt.dims);
      near(pt.spacing[0], g.spacingMm[0], 1e-6, "画素間隔（列）");
      near(pt.spacing[2], g.spacingMm[2], 1e-6, "スライス間隔");
      near(pt.ipp[2], -((g.slices - 1) / 2) * g.spacingMm[2], 1e-6, "★ 先頭スライスの患者座標 z");
      check(pt.iop.join(",") === "1,0,0,0,1,0", "IOP", pt.iop);
      check(pt.modality === "PT", "モダリティ", pt.modality);
      check(pt.length === g.cols * g.rows * g.slices, "画素数", pt.length);
      check(pt.finite === pt.length, "全ボクセルが有限値", { finite: pt.finite, length: pt.length });
      check(!!pt.frameOfReferenceUid, "FrameOfReference を返す", pt.frameOfReferenceUid);
    }
    const liver = truth.objects.find((o: { id: string }) => o.id === "liver");
    const wantConc = liver.concentrationBqPerMl["4.0"] as number;
    check(!!probe.ptLiverValue, "肝の位置の値が取れる");
    if (probe.ptLiverValue) {
      const got = probe.ptLiverValue.value;
      check(Math.abs(got - wantConc) / wantConc < 0.01,
        `★ 患者座標 (-60,-10,20) の値が真値と一致（期待 ${Math.round(wantConc)} / 実測 ${Math.round(got)} Bq/mL）`);
    }
    const ct = probe.ctVolume;
    if (ct) {
      const g = truth.geometry.ct;
      check(JSON.stringify(ct.dims) === JSON.stringify([g.cols, g.rows, g.slices]), "★ CT の次元（別格子）", ct.dims);
      near(ct.spacing[0], g.spacingMm[0], 1e-6, "CT の画素間隔");
    }
    if (probe.ctLiverValue) {
      near(probe.ctLiverValue.value, liver.hu, 1, "★ CT も同じ患者座標で肝の HU を返す");
    }
    check(probe.resolvedWithoutStudyUid === true, "★ studyUid を省略しても開いているタイルから解決する");
    check(probe.unknownSeries === null, "★ 開いていないシリーズは読めない（患者を跨がせない）", probe.unknownSeries);

    console.log("\n[5] H21（位置合わせとリサンプル）");
    const reg = probe.registration;
    check(!!reg, "位置合わせが走る");
    if (reg) {
      check(!reg.aborted, "中断していない");
      const t = Math.hypot(reg.translationMm[0], reg.translationMm[1], reg.translationMm[2]);
      check(t < 0.5, `★ 同一シリーズ同士なら移動量ゼロ（${t.toFixed(3)} mm）`);
      const r = Math.max(...reg.eulerDeg.map(Math.abs));
      check(r < 0.5, `★ 回転もゼロ（${r.toFixed(3)}°）`);
      console.log(`  metric=${reg.metricValue.toFixed(4)} ${reg.elapsedMs} ms`);
    }
    const rs = probe.resampled;
    check(!!rs, "リサンプルできる");
    if (rs && ct) {
      check(JSON.stringify(rs.dims) === JSON.stringify(ct.dims), "★ 出力は CT の格子", rs.dims);
      near(rs.spacing[0], ct.spacing[0], 1e-9, "出力の画素間隔");
    }
    if (probe.resampledLiverValue) {
      const got = probe.resampledLiverValue.value;
      check(Math.abs(got - wantConc) / wantConc < 0.02,
        `★ CT 格子へ引き直しても肝の値が保たれる（期待 ${Math.round(wantConc)} / 実測 ${Math.round(got)} Bq/mL）`);
    }
    check(probe.resampledOutside === null, "格子の外は index が外れる（値を作らない）", probe.resampledOutside);
    await viewer.screenshot({ path: path.join(OUT_DIR, "final.png") });
  } finally {
    await driver.stop().catch(() => undefined);
  }

  console.log("");
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  for (const f of failures) console.log(` - ${f}`);
  console.log(`出力: ${OUT_DIR}`);
  if (failures.length > 0) process.exit(1);
}

/** シリーズの先頭 SOP UID（フレーム切り出し URL に要る）。 */
async function firstSop(http: number, studyUid: string, seriesUid: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${http}/api/studies/${studyUid}/series/${seriesUid}/instances`);
  const list = (await res.json()) as { sopInstanceUid: string }[];
  return list[0]?.sopInstanceUid ?? "";
}

await main();

/*
 * NIfTI の float を Parametric Map で取り込んだシリーズを書き出して、取り込み直しても値・NaN・幾何・単位が変わらないか
 * （fw/nifti-import.md §3.1・段 F5）。Colab は使わない。
 *
 * 実行:  cd automator && GRAPHY_TEST_PYTHON=<numpy と nibabel のある python> npx tsx src/spike/niftiRoundTripCheck.ts
 *
 * 経路は 2 本: (1) そのままの ZIP（DICOMDIR つき）→ 検査を消す → 取り込み直す、(2) 匿名化 ZIP（UID・患者が変わる）→ 取り込む。
 * 答えは scripts/make-float-nifti.py が NIfTI のアフィンから出した患者座標と float32 の値。本体の H10 で読んだ値と突き合わせる。
 * 書き出したファイルそのものも pydicom で読んで元の NIfTI と全ボクセル比べる（scripts/dicom-series-to-nifti.py・compare-nifti.py）。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "nifti-roundtrip-check");
const PROBE_ID = "nifti-roundtrip-probe";
const { check, summary } = createChecker();
const PYTHON = process.env.GRAPHY_TEST_PYTHON ?? "python";

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
    const v = vol.data[i + nx * (j + ny * k)];
    return Number.isNaN(v) ? null : v;
  });
  let nan = 0;
  for (let p = 0; p < vol.data.length; p++) if (Number.isNaN(vol.data[p])) nan++;
  window.__probe = { dims: vol.dims, unit: vol.unit, at, nan, studyUid: t.studyUid, seriesUid: t.seriesUid };
}
`;

interface Truth {
  dims: number[];
  nanVoxels: number;
  samples: { index: number[]; lps: number[]; value: number | null }[];
}

interface Layout {
  nZ: number;
  imageWidth: number;
  imageHeight: number;
  zSpatial?: number[];
  imageOrientationPatient?: number[];
  pixelFormat?: { bitsAllocated: number };
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const nii = path.join(OUT_DIR, "adc.nii.gz");
  const truthPath = path.join(OUT_DIR, "truth.json");
  const gen = spawnSync(PYTHON, [path.join(AUTOMATOR_ROOT, "scripts", "make-float-nifti.py"), nii, truthPath], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`NIfTI を作れませんでした: ${gen.stderr}`);
  const truth = JSON.parse(fs.readFileSync(truthPath, "utf8")) as Truth;

  const probeDir = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PROBE_ID);
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(path.join(probeDir, "plugin.json"), JSON.stringify({ id: PROBE_ID, name: "NIfTI round-trip probe", version: "0.0.1", contributes: ["viewer2d.menu"], ui: "ui.js" }));
  fs.writeFileSync(path.join(probeDir, "ui.js"), PROBE_UI);

  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    const base = `http://localhost:${driver.ports.http}`;
    const post = (p: string, body: unknown) =>
      fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const layoutOf = async (study: string, series: string) =>
      (await (await fetch(`${base}/api/studies/${study}/series/${series}/layout`)).json()) as Layout;

    const res = await post("/api/nifti/import", { path: nii, modality: "MR", patientId: "NIFTI-RT", patientName: "Roundtrip^Nifti", seriesDescription: "ADC float", valueUnit: "mm2/s" });
    const r = (await res.json()) as { studyInstanceUid: string; seriesInstanceUid: string; imported: number; error: string | null };
    check(res.ok && !r.error && r.imported === truth.dims[2], `取り込み ${r.imported} 件`, r);
    const lay0 = await layoutOf(r.studyInstanceUid, r.seriesInstanceUid);

    // ── 書き出し ──
    const plainZip = path.join(OUT_DIR, "plain.zip");
    const ex = await post("/api/export/zip", { selections: [{ studyUid: r.studyInstanceUid, seriesUids: [r.seriesInstanceUid] }], includeDicomDir: true, includePortableViewer: false, includeReadme: false });
    fs.writeFileSync(plainZip, Buffer.from(await ex.arrayBuffer()));
    check(ex.ok, `そのままの ZIP を書き出す（${ex.status}・${fs.statSync(plainZip).size} バイト）`);
    const anonZip = path.join(OUT_DIR, "anon.zip");
    const an = await post("/api/anonymizer/zip", { studyUids: [r.studyInstanceUid], options: [], replacePatientName: "ANON^F5", replacePatientId: "ANON-F5", randomSeed: 5, manualRetainTags: [], customReplacements: {}, burnIn: false, destination: null });
    fs.writeFileSync(anonZip, Buffer.from(await an.arrayBuffer()));
    check(an.ok, `匿名化 ZIP を書き出す（${an.status}・${fs.statSync(anonZip).size} バイト）`);

    const unzip = (zip: string, dir: string) => {
      const u = spawnSync(PYTHON, ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2]); print(len(z.namelist()))", zip, dir], { encoding: "utf8" });
      if (u.status !== 0) throw new Error(u.stderr);
      return Number(u.stdout.trim());
    };
    const plainDir = path.join(OUT_DIR, "plain");
    const anonDir = path.join(OUT_DIR, "anon");
    const nPlain = unzip(plainZip, plainDir);
    const nAnon = unzip(anonZip, anonDir);
    check(fs.existsSync(path.join(plainDir, "DICOMDIR")), `そのままの ZIP に DICOMDIR がある（${nPlain} ファイル）`);
    // DICOMDIR の画像の記録が Parametric Map を指す（他のビューアが DICOMDIR から辿れる）
    const dd = spawnSync(PYTHON, ["-c", [
      "import sys, pydicom",
      "d = pydicom.dcmread(sys.argv[1])",
      "recs = [r for r in d.DirectoryRecordSequence if r.DirectoryRecordType not in ('PATIENT','STUDY','SERIES')]",
      "print(len(recs), sorted({r.DirectoryRecordType for r in recs}), sorted({str(r.ReferencedSOPClassUIDInFile) for r in recs}))",
    ].join("\n"), path.join(plainDir, "DICOMDIR")], { encoding: "utf8" });
    console.log(`    DICOMDIR: ${dd.stdout.trim() || dd.stderr.trim()}`);
    check(dd.status === 0 && dd.stdout.startsWith(`${truth.dims[2]} `) && dd.stdout.includes("1.2.840.10008.5.1.4.1.1.30"),
      `DICOMDIR に Parametric Map の記録が ${truth.dims[2]} 件`, dd.stdout + dd.stderr);

    // 本体と独立した読み手（pydicom・nibabel）でも、書き出したファイルの値が元の NIfTI と全ボクセル一致するか
    for (const [label, dir] of [["plain", plainDir], ["anon", anonDir]] as const) {
      const back = path.join(OUT_DIR, `${label}-back.nii.gz`);
      const conv = spawnSync(PYTHON, [path.join(AUTOMATOR_ROOT, "scripts", "dicom-series-to-nifti.py"), dir, back], { encoding: "utf8" });
      const cmp = spawnSync(PYTHON, [path.join(AUTOMATOR_ROOT, "scripts", "compare-nifti.py"), nii, back], { encoding: "utf8" });
      const lines = (cmp.stdout ?? "").trim().split(/\r?\n/);
      check(conv.status === 0 && /parametric-map/.test(conv.stdout) && lines.at(-1) === "RESULT same",
        `[${label}] pydicom で読んだ値が元の NIfTI と全ボクセル一致（${lines.filter((l) => /NaN|max \|diff/.test(l)).join(" / ")}）`, conv.stderr + cmp.stderr + cmp.stdout);
    }

    // ── そのままの ZIP: 検査を消してから取り込み直す（同じ UID で戻る）──
    const del = await fetch(`${base}/api/studies/${r.studyInstanceUid}`, { method: "DELETE" });
    check(del.ok, `元の検査を消す（${del.status}）`);
    const gone = await fetch(`${base}/api/studies/${r.studyInstanceUid}/series/${r.seriesInstanceUid}/layout`);
    check(!gone.ok || ((await gone.json()) as Layout).nZ === 0, `消えたことを確かめる（layout ${gone.status}）`);
    const imp1 = (await (await post("/api/import/paths", { paths: [plainDir] })).json()) as { imported: number; failed: number; errors: string[] };
    check(imp1.imported === truth.dims[2] && imp1.failed === 0, `そのままの ZIP を取り込み直す（${imp1.imported} 件・失敗 ${imp1.failed}）`, imp1);
    const lay1 = await layoutOf(r.studyInstanceUid, r.seriesInstanceUid);
    check(JSON.stringify(lay1.zSpatial) === JSON.stringify(lay0.zSpatial) && JSON.stringify(lay1.imageOrientationPatient) === JSON.stringify(lay0.imageOrientationPatient)
      && lay1.pixelFormat?.bitsAllocated === 32 && lay1.nZ === lay0.nZ, "取り込み直したレイアウト（z の位置・IOP・32 bit）が元と同じ", { lay0, lay1 });

    // ── 匿名化 ZIP: 新しい UID で入る ──
    const imp2 = (await (await post("/api/import/paths", { paths: [anonDir] })).json()) as { imported: number; failed: number };
    check(imp2.imported === truth.dims[2] && imp2.failed === 0, `匿名化 ZIP を取り込む（${imp2.imported} 件・失敗 ${imp2.failed}・${nAnon} ファイル）`, imp2);

    // ── 画面から H10 で読み、答えと突き合わせる ──
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();

    const rows = page.locator('[data-testid^="study-row-"]');
    await rows.first().waitFor({ timeout: 30_000 });
    const studyIds = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice("study-row-".length)));
    check(studyIds.length === 2 && studyIds.includes(r.studyInstanceUid), `一覧に検査が 2 つ（元の UID・匿名化の UID）`, studyIds);

    const probe = async (studyUid: string, label: string) => {
      await page.locator(`[data-testid="study-row-${studyUid}"]`).click();
      const seriesRow = page.locator('[data-testid^="series-row-"]').first();
      await seriesRow.waitFor({ timeout: 30_000 });
      await seriesRow.click();
      const viewer: Page = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
      await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
      await viewer.waitForTimeout(3_000);
      await viewer.screenshot({ path: path.join(OUT_DIR, `viewer-${label}.png`) });
      await viewer.evaluate((s) => Object.assign(window, { __probeSamples: s }), truth.samples);
      await viewer.getByTestId("viewer2d-menu-plugins").click();
      await viewer.getByTestId(`plugin-item-${PROBE_ID}`).click();
      await viewer.waitForFunction(() => !!(window as unknown as { __probe?: unknown }).__probe, null, { timeout: 60_000 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p: any = await viewer.evaluate(() => (window as unknown as { __probe: unknown }).__probe);
      await viewer.close();
      fs.writeFileSync(path.join(OUT_DIR, `probe-${label}.json`), JSON.stringify(p, null, 1));
      check(!p.error && p.dims.join("x") === truth.dims.join("x"), `[${label}] H10 の格子 ${p.dims?.join("×")}`, p.error);
      if (p.error) return p;
      const mismatch = truth.samples.filter((s, i) => (s.value === null ? p.at[i] !== null : p.at[i] !== s.value));
      check(mismatch.length === 0, `[${label}] ${truth.samples.length} ボクセルの値が元の float32 とビット単位で一致（NaN は NaN）`, { at: p.at, want: truth.samples.map((s) => s.value) });
      check(p.nan === truth.nanVoxels, `[${label}] NaN は ${truth.nanVoxels} ボクセルのまま（${p.nan}）`);
      check(p.unit === "mm2/s", `[${label}] 単位 mm2/s が残る（${p.unit}）`);
      return p;
    };
    const p1 = await probe(r.studyInstanceUid, "plain");
    check(p1.seriesUid === r.seriesInstanceUid, "[plain] UID は元のまま");
    const anonStudy = studyIds.find((s) => s !== r.studyInstanceUid);
    if (anonStudy) {
      const p2 = await probe(anonStudy, "anon");
      check(p2.studyUid !== r.studyInstanceUid && p2.seriesUid !== r.seriesInstanceUid, "[anon] UID は置き換わっている");
      const anonLay = await layoutOf(p2.studyUid, p2.seriesUid);
      check(JSON.stringify(anonLay.zSpatial) === JSON.stringify(lay0.zSpatial), "[anon] z の位置が元と同じ（匿名化で幾何が変わらない）", anonLay.zSpatial);
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

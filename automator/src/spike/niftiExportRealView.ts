/*
 * NIfTI 書き出しの向きの目視。自動検査（niftiExportCheck.ts）とは別に必ず行う。
 *
 * 実 CT（~/graphy_sample_images/HCC_001/PRE LIVER。公開・匿名化済みの軸位 CT）と、そこから補間なしの軸の入れ替えで作った
 * 矢状断（scripts/make-sagittal-from-ct.py。「実 CT 由来の矢状断」であって実データの矢状断ではない）を取り込み、
 * メイン画面のメニューで書き出し、nibabel（as_closest_canonical）で中央の 1 枚を向きの文字つきで描く。
 * 同じ位置の GRAPHY の 2D 表示（元シリーズ）のスクリーンショットと並べた画像を出力する。
 *
 * 実行:  cd automator && NIFTI_PY=<nibabel・matplotlib・PIL の入った python> REAL_CT_DIR=<軸位 CT のフォルダ> timeout 900 npx tsx src/spike/niftiExportRealView.ts
 * 出力: .results/nifti-export-real/{axial,sagittal}-side-by-side.png（患者情報を含まない。リポジトリには入れない）
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { WebDriver } from "../driver/webDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const PY = process.env.NIFTI_PY ?? "python3";
const REAL = process.env.REAL_CT_DIR ?? path.join(process.env.HOME ?? "", "graphy_sample_images", "HCC_001", "PRE LIVER");
const OUT = path.join(AUTOMATOR_ROOT, ".results", "nifti-export-real");

function py(args: string[]): { status: number; out: string } {
  const r = spawnSync(PY, ["-I", ...args], { encoding: "utf8" });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function listSeries(base: string): Promise<Array<{ study: string; series: string; patient: string; n: number }>> {
  const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId: string }[];
  const out: Array<{ study: string; series: string; patient: string; n: number }> = [];
  for (const s of studies) {
    const ser = (await (await fetch(`${base}/api/studies/${s.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; numberOfInstances: number }[];
    for (const x of ser) out.push({ study: s.studyInstanceUid, series: x.seriesInstanceUid, patient: s.patientId, n: x.numberOfInstances });
  }
  return out;
}

async function selectSeries(p: Page, study: string, series: string): Promise<void> {
  await p.reload();
  await p.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
  await p.getByTestId("search-allperiod-chip").click();
  await p.getByTestId("search-submit-button").click();
  await p.locator(`[data-testid="study-row-${study}"]`).click();
  await p.locator(`[data-testid="series-row-${series}"]`).click();
  await p.waitForTimeout(800);
}

async function main(): Promise<number> {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(path.join(AUTOMATOR_ROOT, ".results", "run-data", "web"), { recursive: true, force: true });
  const sag = path.join(OUT, "sagittal-dicom");
  const made = py([path.join(AUTOMATOR_ROOT, "scripts", "make-sagittal-from-ct.py"), REAL, sag]);
  console.log(made.out.trim().split("\n").map((l) => `  ${l}`).join("\n"));
  if (made.status !== 0) throw new Error("矢状断の DICOM を作れませんでした");

  const d = new WebDriver({ http: 18690, scp: 18691, vite: 18693 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    await resetDb(d.ports.http);
    const base = `http://127.0.0.1:${d.ports.http}`;
    const CAP = path.join(path.dirname(REAL), "C-A-P"); // 撮影が 2 回ぶん混ざった実シリーズ（66 枚・位置 38 か所のうち 28 か所が 2 枚。時相の手がかりなし）
    const a = await importPaths(d.ports.http, [REAL]);
    const cap = fs.existsSync(CAP) ? await importPaths(d.ports.http, [CAP]) : null;
    const s = await importPaths(d.ports.http, [sag]);
    check(a.failed === 0 && s.failed === 0, "（前提）実 CT と、そこから作った矢状断を取り込めた", { a: a.imported, s: s.imported });
    const all = await listSeries(base);
    const axial = all.find((x) => x.patient !== "DERIVED-SAGITTAL" && x.n === 43)!;
    const sagittal = all.find((x) => x.patient === "DERIVED-SAGITTAL")!;
    const p = d.page;
    await p.reload();
    await p.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });

    for (const [plane, ser, mid] of [["axial", axial, Math.floor(axial.n / 2)], ["sagittal", sagittal, Math.floor(sagittal.n / 2)]] as const) {
      console.log(`\n[${plane}] ${ser.n} 枚`);
      await selectSeries(p, ser.study, ser.series);
      await p.getByRole("button", { name: /^(ファイル|File)$/ }).first().click();
      const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 120_000 }), p.getByTestId("menu-item-nifti-export").click()]);
      const nii = path.join(OUT, `${plane}.nii.gz`);
      await dl.saveAs(nii);
      check(fs.statSync(nii).size > 1000, `${plane}: メニューから .nii.gz を保存できた`, fs.statSync(nii).size);
      // 元シリーズの 2D 表示（中央のスライス）
      const v = await d.waitForNewPage(() => p.getByTestId("viewer2d-toolbar-button").click(), () => true, 30_000);
      await v.setViewportSize({ width: 1000, height: 800 });
      await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
      await v.waitForTimeout(3000);
      const slider = v.locator('input[type="range"]').first();
      await slider.fill(String(mid + 1));
      await v.waitForTimeout(2000);
      const view = path.join(OUT, `${plane}-graphy.png`);
      await v.locator('[data-testid="viewer2d-canvas-host"]').first().screenshot({ path: view });
      await v.close();
      // nibabel の中央の 1 枚（向きの文字つき）
      const png = path.join(OUT, `${plane}-nibabel.png`);
      const r = py([path.join(AUTOMATOR_ROOT, "scripts", "render-nifti-slice.py"), nii, png, plane, String(mid)]);
      console.log(r.out.trim().split("\n").map((l) => `  ${l}`).join("\n"));
      check(r.status === 0, `${plane}: nibabel で描けた`, r.out.slice(0, 200));
      // 左右に並べる
      const both = py(["-c", [
        "import sys; from PIL import Image",
        "a = Image.open(sys.argv[1]).convert('RGB'); b = Image.open(sys.argv[2]).convert('RGB')",
        "h = 640; a = a.resize((int(a.width * h / a.height), h)); b = b.resize((int(b.width * h / b.height), h))",
        "c = Image.new('RGB', (a.width + b.width + 20, h), 'white'); c.paste(a, (0, 0)); c.paste(b, (a.width + 20, 0)); c.save(sys.argv[3])",
      ].join("\n"), view, png, path.join(OUT, `${plane}-side-by-side.png`)]);
      check(both.status === 0, `${plane}: GRAPHY の 2D 表示（左）と nibabel（右）を並べた画像を出力`, both.out.slice(0, 200));
    }
    if (cap) {
      console.log("\n[実データの負例] C-A-P（撮影が 2 回ぶん混ざった実シリーズ）は 4D にせず、従来の理由で断る");
      const capSeries = all.find((x) => x.n === 66)!;
      await selectSeries(p, capSeries.study, capSeries.series);
      await p.getByRole("button", { name: /^(ファイル|File)$/ }).first().click();
      let downloaded = false;
      const onDl = () => { downloaded = true; };
      p.on("download", onDl);
      await p.getByTestId("menu-item-nifti-export").click();
      const msg = p.getByTestId("nifti-export-msg");
      await msg.filter({ hasText: /書き出せませんでした/ }).waitFor({ state: "visible", timeout: 30_000 });
      await p.waitForTimeout(1500);
      p.off("download", onDl);
      const t = await msg.innerText();
      console.log(`  帯: ${t}`);
      check(/同じ位置に 2 枚以上/.test(t), "C-A-P: 「同じ位置に 2 枚以上」で断られる（時相の手がかりが無い重複を黙って 4D にしない）", t);
      check(!downloaded, "C-A-P: ファイルは保存されない", null);
    }
    console.log(`\n出力: ${OUT}`);
    return summary();
  } finally {
    await d.stop();
  }
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });

/*
 * PET ファントム（Bq/mL・DICOM に WL/WW も SUV 係数も無い）が、LUT「Gray」の既定表示で崩れる件の再現と、直したことの確認。
 * 調査（初期の窓が幅 0 になり、vtk の色関数が壊れる）が実アプリで当たっているかを、測って確かめる。
 *
 * 実行:  cd automator && npx tsx src/spike/petGrayWindowCheck.ts
 *   PHANTOM_DIR=<GNBP-D/dicom/tp0-pt> で別のデータも指せる（既定: dosimetry プラグインの bench）
 *
 * 見ること（画像の canvas を読み戻す。DOM や数値だけで合格にしない。スクリーンショットも見る）:
 *   - 開いた直後・Auto の後・反転の後で、画像の明るさの段階（体外 0 < 背景 7465 < 臓器 約 11〜16 万）が、
 *     値の大きさの順に明るくなっている（反転していない）こと。
 *   - 開いたスライスの番号（先頭の全 0 のスライスから開いているか）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "pet-gray-window");
const PHANTOM_DIR = process.env.PHANTOM_DIR ?? path.join(os.homedir(), "graphy-workspace", "graphy-next-plugin-dosimetry", "bench", "phantom", "GNBP-D", "dicom", "tp0-pt");
const { check, summary } = createChecker();

/** 最も大きい canvas（画像のビューポート）を読み戻し、灰色の段階ごとの画素数を返す。 */
const SAMPLE = `(() => {
  const canvases = [...document.querySelectorAll("canvas")].filter((c) => c.width > 200 && c.height > 200);
  canvases.sort((a, b) => b.width * b.height - a.width * a.height);
  const c = canvases[0];
  if (!c) return null;
  const off = document.createElement("canvas");
  off.width = c.width; off.height = c.height;
  const ctx = off.getContext("2d");
  ctx.drawImage(c, 0, 0);
  const d = ctx.getImageData(0, 0, off.width, off.height).data;
  const hist = new Map();
  let colored = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (Math.abs(r - g) > 6 || Math.abs(g - b) > 6) colored++;
    const k = r;
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  const levels = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { w: c.width, h: c.height, coloredPixels: colored, levels };
})()`;

type Sample = { w: number; h: number; coloredPixels: number; levels: [number, number][] } | null;

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(PHANTOM_DIR)) throw new Error(`データがありません: ${PHANTOM_DIR}`);
  const driver = new DesktopDriver();
  const report: Record<string, unknown> = {};
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    const base = `http://localhost:${driver.ports.http}`;
    const imp = await fetch(`${base}/api/import/paths`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: [PHANTOM_DIR] }),
    });
    const ir = (await imp.json()) as { imported: number; failed: number; studyInstanceUids: string[] };
    check(imp.ok && ir.imported === 48 && ir.failed === 0, `PET を取り込めた（${ir.imported} 件）`, ir);
    const studyUid = ir.studyInstanceUids[0];
    const series = (await (await fetch(`${base}/api/studies/${studyUid}/series`)).json()) as { seriesInstanceUid: string }[];
    const seriesUid = series[0].seriesInstanceUid;

    await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${studyUid}"]`).click();
    await page.locator(`[data-testid="series-row-${seriesUid}"]`).click();
    const viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
    await viewer.waitForTimeout(3_000);

    const zText = (await viewer.locator("text=/Z \\d+\\/\\d+/").first().textContent().catch(() => null)) ?? "";
    const wl0 = ((await viewer.getByTestId("status-wl").textContent()) ?? "").trim();
    const s0 = (await viewer.evaluate(SAMPLE)) as Sample;
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-initial.png") });
    report.initial = { z: zText, wl: wl0, sample: s0 };
    console.log(`  開いた直後: ${zText} / W/L ${wl0} / 段階 ${JSON.stringify(s0?.levels)} / 色付き ${s0?.coloredPixels}`);

    // 中身のあるスライス（24 枚目＝添字 24）へ、スライダーで動かして、同じ測定（スライスに依らず窓が壊れていないか）
    await viewer.evaluate(`(() => {
      const r = document.querySelector('input[type="range"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(r, "24");
      r.dispatchEvent(new Event("input", { bubbles: true }));
      r.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await viewer.waitForTimeout(1200);
    const zText2 = (await viewer.locator("text=/Z \\d+\\/\\d+/").first().textContent().catch(() => null)) ?? "";
    const s1 = (await viewer.evaluate(SAMPLE)) as Sample;
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-slice-moved.png") });
    report.moved = { z: zText2, sample: s1 };
    console.log(`  スライス移動後: ${zText2} / 段階 ${JSON.stringify(s1?.levels)} / 色付き ${s1?.coloredPixels}`);

    // Auto
    await viewer.getByTestId("viewer2d-menu-image").click();
    await viewer.getByTestId("menu-wl-adjust").click();
    const dlg = viewer.getByTestId("wl-adjust-dialog");
    await dlg.waitFor({ state: "visible", timeout: 10_000 });
    await viewer.waitForTimeout(1_000);
    await dlg.getByRole("button", { name: "自動", exact: true }).click();
    await viewer.waitForTimeout(800);
    const wlAuto = ((await viewer.getByTestId("status-wl").textContent()) ?? "").trim();
    const s2 = (await viewer.evaluate(SAMPLE)) as Sample;
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-after-auto.png") });
    report.auto = { wl: wlAuto, sample: s2 };
    console.log(`  Auto 後: W/L ${wlAuto} / 段階 ${JSON.stringify(s2?.levels)} / 色付き ${s2?.coloredPixels}`);
    await dlg.getByRole("button", { name: "閉じる", exact: true }).click();

    // 反転
    await viewer.getByTestId("toolbar-invert").click();
    await viewer.waitForTimeout(600);
    const s3 = (await viewer.evaluate(SAMPLE)) as Sample;
    await viewer.screenshot({ path: path.join(OUT_DIR, "4-inverted.png") });
    report.inverted = { sample: s3 };
    console.log(`  反転後: 段階 ${JSON.stringify(s3?.levels)} / 色付き ${s3?.coloredPixels}`);
    await viewer.getByTestId("toolbar-invert").click();
    await viewer.waitForTimeout(600);
    const s4 = (await viewer.evaluate(SAMPLE)) as Sample;
    await viewer.screenshot({ path: path.join(OUT_DIR, "5-invert-back.png") });
    report.invertBack = { sample: s4 };
    console.log(`  反転を戻した後: 段階 ${JSON.stringify(s4?.levels)} / 色付き ${s4?.coloredPixels}`);

    fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 1));

    // 判定。中身のあるスライス（24 枚目）で、値の大きさの順に明るくなっている（反転していない）こと:
    //   体外（0 Bq/mL）は黒、背景（約 7000 Bq/mL）は暗い灰色、臓器（約 11〜16 万 Bq/mL）は明るい。
    //   背景は臓器より画素数が多い。反転していると背景が白くなる。
    const levels = (s: Sample) => (s ? s.levels.filter(([, n]) => n > 20) : []);
    const orderedOk = (s: Sample): boolean => {
      const l = levels(s);
      const dark = l.filter(([v]) => v >= 5 && v <= 60);
      const bright = l.filter(([v]) => v >= 140);
      if (dark.length === 0 || bright.length === 0) return false;
      const darkN = Math.max(...dark.map(([, n]) => n));
      const brightN = Math.max(...bright.map(([, n]) => n));
      return darkN > brightN; // 広い背景が暗く、小さい臓器が明るい
    };
    check(orderedOk(s1), "スライス移動後: 背景は暗く、臓器は明るい（値の大きさの順。反転していない）", levels(s1));
    check((s1?.coloredPixels ?? 1) === 0, "スライス移動後: 色が付かない（赤くならない）", s1?.coloredPixels);
    // Auto はいま見ているスライスの値域に合わせる。ここでは 24 枚目で押す（中身がある）
    check(orderedOk(s2), "Auto 後（24 枚目）: 背景は暗く、臓器は明るい", levels(s2));
    check((s2?.coloredPixels ?? 1) === 0, "Auto 後: 色が付かない", s2?.coloredPixels);
    // 反転: 背景が明るく、臓器が暗い（色は付かない）
    const invOk = (s: Sample): boolean => {
      const l = levels(s);
      const bright = l.filter(([v]) => v >= 140);
      const dark = l.filter(([v]) => v >= 0 && v <= 60);
      if (!bright.length || !dark.length) return false;
      return Math.max(...bright.map(([, n]) => n)) > Math.max(...dark.filter(([v]) => v > 0).map(([, n]) => n), 0);
    };
    check(invOk(s3), "反転後: 背景が明るく、臓器が暗い（反転として働く）", levels(s3));
    check((s3?.coloredPixels ?? 1) === 0, "反転後: 色が付かない（赤くならない）", s3?.coloredPixels);
    check(orderedOk(s4), "反転を戻した後: 元の（背景が暗い）表示に戻る", levels(s4));
    check((s4?.coloredPixels ?? 1) === 0, "反転を戻した後: 色が付かない", s4?.coloredPixels);
  } finally {
    await driver.stop().catch(() => undefined);
  }
  summary();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

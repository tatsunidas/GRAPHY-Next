/*
 * %ID/cc 校正（体重なしの PET）の実機検証（Chromium＋実 backend＋合成ファントム）。
 *
 * 実行:  cd automator && timeout 600 npx tsx src/spike/suvPidCheck.ts
 *        （ファントムの生成に pydicom のある Python が要る: GRAPHY_TEST_PYTHON、既定は python）
 *
 * 確かめること（真値は濃度と投与量から**解析式**で出す。アプリと同じ計算は書かない）:
 *  1. SUV 校正ダイアログを**操作**して、既定（SUVbw）のまま適用すると、体重が無いので拒否される（負例）。
 *  2. %ID/cc を選んで適用すると、カーソル値が C×100/崩壊後投与量、単位 %ID/cc になる（目的球・参照球・背景）。
 *  3. 目的球の内側の矩形 ROI の平均が同じ値（2D ROI の統計経路）。
 *  4. 既定ウィンドウで球が見える（画面の輝度が真っ黒・真っ白でない）— スクリーンショットで判定。
 *  5. 校正を解除すると BQML に戻る。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "suv-pid-check");
const PHANTOM_DIR = path.join(OUT_DIR, "phantom");
const { check, summary } = createChecker();

async function cursorValue(p: Page, x: number, y: number): Promise<{ text: string; num: number }> {
  await p.mouse.move(x + 7, y + 7);
  await p.mouse.move(x, y);
  await p.waitForTimeout(500);
  const text = (await p.getByTestId("status-value").first().innerText()).trim();
  return { text, num: parseFloat(text) };
}

async function openSuvDialog(v: Page): Promise<void> {
  await v.getByTestId("viewer2d-menu-image").click();
  await v.getByTestId("menu-suv").click();
  await v.getByTestId("suv-dialog").waitFor({ state: "visible", timeout: 10_000 });
}

async function main(): Promise<void> {
  fs.rmSync(PHANTOM_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const py = process.env.GRAPHY_TEST_PYTHON ?? "python";
  const gen = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", "make-pet-suv-phantom.py"), PHANTOM_DIR], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`ファントムを作れませんでした: ${gen.stderr}`);
  const truth = JSON.parse(fs.readFileSync(path.join(PHANTOM_DIR, "truth.json"), "utf8"));
  // 期待値: アプリの実装とは別の式（exp）。
  const decayed = truth.dose_bq * Math.exp((-Math.LN2 * 3600) / truth.half_life_s);
  const pct = (c: number) => (c * 100) / decayed;

  const d = new WebDriver({ http: 18640, scp: 18641, vite: 18643 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    await resetDb(d.ports.http);
    console.log(`  import: ${JSON.stringify(await importPaths(d.ports.http, [PHANTOM_DIR])).slice(0, 120)}`);
    await d.page.reload();
    await d.page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await d.page.getByTestId("search-allperiod-chip").click();
    await d.page.getByTestId("search-submit-button").click();
    await d.page.locator('[data-testid^="study-row-"]').first().click();
    await d.page.locator('[data-testid^="series-row-"]').first().click();
    await d.page.waitForTimeout(2500);
    const v = await d.waitForNewPage(() => d.page.getByTestId("viewer2d-toolbar-button").click(), () => true, 30_000);
    await v.setViewportSize({ width: 1400, height: 900 });
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await v.waitForTimeout(3000);
    // 中央スライス（z = 0）へ: 21 枚の中央は index 10。先頭から 10 枚送る。
    const tile = v.getByTestId("series-viewer-root").first();
    const tileBox = (await tile.boundingBox())!;
    const box = (await v.locator('[data-testid="viewer2d-canvas-host"] canvas').first().boundingBox())!;
    await v.mouse.move(tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height / 2);
    for (let i = 0; i < 25; i++) { await v.mouse.wheel(0, -100); await v.waitForTimeout(60); }
    for (let i = 0; i < 10; i++) { await v.mouse.wheel(0, 100); await v.waitForTimeout(200); }
    await v.waitForTimeout(1200);
    // 視野 256 mm を表示領域の短辺に合わせた画素/mm。球は x = ±40 mm。
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const ppm = Math.min(box.width, box.height) / 256;
    const spots = {
      mid: [cx, cy],
      right: [cx + 40 * ppm, cy],
      left: [cx - 40 * ppm, cy],
    } as const;

    console.log("\n[1] 校正前（BQML）");
    const raw: Record<string, number> = {};
    for (const [k, [x, y]] of Object.entries(spots)) {
      const r = await cursorValue(v, x, y);
      raw[k] = r.num;
      console.log(`  ${k}: ${r.text}`);
    }
    // 目的球 = 最も熱い所、参照球 = 2 番目、背景 = 残り（濃度 20000 / 5000 / 1000 の順位だけを使う）
    const order = Object.entries(raw).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    check(Math.abs(raw[order[0]] - truth.c_target) < 0.01 * truth.c_target, "目的球の BQML 値が濃度どおり", raw);
    check(Math.abs(raw[order[1]] - truth.c_ref) < 0.01 * truth.c_ref, "参照球の BQML 値が濃度どおり", raw);
    check(Math.abs(raw[order[2]] - truth.c_bg) < 0.01 * truth.c_bg, "背景の BQML 値が濃度どおり", raw);
    const tgt = spots[order[0] as keyof typeof spots];
    const ref = spots[order[1] as keyof typeof spots];
    const bg = spots[order[2] as keyof typeof spots];
    await v.screenshot({ path: path.join(OUT_DIR, "1-before.png") });
    console.log("\n[2] 既定（SUVbw）のまま適用 → 体重が無いので拒否（負例）");
    await openSuvDialog(v);
    const defType = await v.getByTestId("suv-type").inputValue();
    check(defType === "bw", "計算タイプの既定は SUVbw", defType);
    const wt0 = await v.getByTestId("suv-weight").inputValue();
    check(wt0.trim() === "", "このファントムは体重が空", wt0);
    await v.getByTestId("suv-apply").click();
    await v.waitForTimeout(600);
    check(await v.getByTestId("suv-dialog").isVisible(), "ダイアログは閉じずにエラーを出す", null);
    const errTxt = await v.getByTestId("suv-dialog").innerText();
    check(/必須/.test(errTxt), "必須エラーの文言が出る", errTxt.slice(-80));
    await v.getByTestId("suv-dialog").getByRole("button", { name: /キャンセル|Cancel/ }).click();
    await v.waitForTimeout(500);
    const stillRaw = await cursorValue(v, tgt[0], tgt[1]);
    check(/BQML/i.test(stillRaw.text), "校正は付かない（BQML のまま）", stillRaw.text);

    console.log("\n[3] %ID/cc を選んで適用");
    await openSuvDialog(v);
    await v.getByTestId("suv-type").selectOption("pid");
    await v.getByTestId("suv-apply").click();
    await v.waitForTimeout(2500);
    check(!(await v.getByTestId("suv-dialog").isVisible().catch(() => false)), "ダイアログが閉じる（適用された）", null);
    for (const [name, spot, c] of [["目的球", tgt, truth.c_target], ["参照球", ref, truth.c_ref], ["背景", bg, truth.c_bg]] as const) {
      const r = await cursorValue(v, spot[0], spot[1]);
      console.log(`  ${name}: ${r.text}（期待 ${pct(c).toExponential(4)}）`);
      check(/%ID\/cc/.test(r.text), `${name}: 単位が %ID/cc`, r.text);
      // 状態バーは小数 2 桁。丸めの範囲（±0.005）で照合し、精密な値は下の ROI 平均で測る。
      check(Math.abs(r.num - pct(c)) <= 0.0051, `${name}: 値が C×100/崩壊後投与量（表示 2 桁の範囲）`, { got: r.num, want: pct(c) });
    }
    await v.screenshot({ path: path.join(OUT_DIR, "3-pid-applied.png") });
    // 表示の判定（画面を見る）: 描かれた画素のうち、背景より明るい球の画素が実際にあること。
    //   既定ウィンドウは 0〜(99.5 百分位) なので、目的球が白（255 近く）、参照球が中間、背景が暗い灰色になる。
    const shot = path.join(OUT_DIR, "3-viewport.png");
    fs.writeFileSync(shot, await v.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } }));
    const lum = spawnSync(py, ["-I", "-c", [
      "import sys, numpy as np; from PIL import Image",
      "a = np.array(Image.open(sys.argv[1]).convert('L')); n = a.size",
      "print(round((a >= 230).sum() / n, 4), round(((a >= 40) & (a < 200)).sum() / n, 4), int(a.max()))",
    ].join("\n"), shot], { encoding: "utf8" });
    const [bright, mid, mx] = lum.stdout.trim().split(" ").map(Number);
    console.log(`  画面: 明るい画素 ${bright} / 中間 ${mid} / 最大 ${mx}`);
    check(bright > 0.005, "目的球が画面で明るく見える（真っ黒でない）", { bright, mid, mx });
    check(mid > 0.005, "参照球が中間の明るさで見える（窓が潰れていない）", { bright, mid, mx });

    console.log("\n[3b] 目的球の内側に矩形 ROI を描く → 平均が同じ値（2D ROI の統計経路）");
    await v.getByTestId("viewer2d-menu-roi").click();
    await v.getByRole("button", { name: /矩形 ROI|Rectangle ROI/ }).first().click();
    await v.waitForTimeout(300);
    const half = 8 * ppm;
    await v.mouse.move(tgt[0] - half, tgt[1] - half);
    await v.mouse.down();
    await v.mouse.move(tgt[0], tgt[1], { steps: 6 });
    await v.mouse.move(tgt[0] + half, tgt[1] + half, { steps: 6 });
    await v.mouse.up();
    await v.waitForTimeout(1500);
    const lines = (await v.evaluate(`(function () {
      var host = document.querySelector('[data-testid="viewer2d-canvas-host"]'); var out = [];
      host.querySelectorAll("svg text").forEach(function (t) {
        var sp = t.querySelectorAll("tspan");
        if (sp.length) sp.forEach(function (x) { out.push((x.textContent || "").trim()); }); else out.push((t.textContent || "").trim());
      });
      return out.filter(function (x) { return x.length > 0; });
    })()`)) as string[];
    console.log(`  ROI 脇: ${JSON.stringify(lines)}`);
    const meanLine = lines.find((l) => /平均|Mean/.test(l)) ?? "";
    const m = /(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(meanLine.replace(/^[^:：]*[:：]\s*/, ""));
    const roiMean = m ? Number(m[1]) : NaN;
    check(Number.isFinite(roiMean) && Math.abs(roiMean / pct(truth.c_target) - 1) < 0.005, "矩形 ROI の平均が C×100/崩壊後投与量（相対 0.5%）", { roiMean, want: pct(truth.c_target), meanLine });
    check(/%ID\/cc/.test(meanLine) || lines.some((l) => /%ID\/cc/.test(l)), "ROI の統計に単位 %ID/cc が出る", lines);
    await v.screenshot({ path: path.join(OUT_DIR, "3b-roi.png") });
    console.log("\n[4] 解除 → BQML に戻る");
    await openSuvDialog(v);
    await v.getByTestId("suv-dialog").getByRole("button", { name: /解除|Clear/ }).first().click();
    await v.waitForTimeout(2000);
    const back = await cursorValue(v, tgt[0], tgt[1]);
    check(/BQML/i.test(back.text), "単位が BQML に戻る", back.text);
    check(Math.abs(back.num - truth.c_target) < 0.01 * truth.c_target, "値が校正前に戻る", back.num);
  } finally {
    await d.stop();
  }
}

main()
  .then(() => process.exit(summary() === 0 ? 0 : 1))
  .catch((e) => {
    console.error(e);
    process.exit(2);
  });

/*
 * SUVR（参照領域比）校正の実機検証（Chromium＋実 backend＋合成ファントム）。
 *
 * 実行:  cd automator && timeout 600 npx tsx src/spike/suvrCheck.ts
 *        （ファントムの生成に pydicom のある Python が要る: GRAPHY_TEST_PYTHON、既定は python）
 *
 * 真値は濃度（目的 2000・参照 500・背景 100 Bq/mL）から決まる: SUVR = 目的 4.0 / 参照 1.0 / 背景 0.2。
 *  1. 参照の ROI が無いと、SUVR は適用できない（負例。適用ボタンが無効で理由が出る）。
 *  2. 参照球に矩形 ROI を描くと候補に出て、平均 500 が見える。適用するとカーソル値が 4.00 / 1.00 / 0.20・単位 SUVR。
 *  3. 目的球の矩形 ROI の平均が 4.0、ROI 脇に TLG が出ない（比には「平均×体積」の意味が無い）。
 *  4. 先に %ID/cc を掛けてから SUVR を適用しても同じ値（乗数が打ち消し合う）。
 *  5. 描かれた画面（画素）で、目的球が明るく・参照球が中間に見える。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "suvr-check");
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

async function drawRect(v: Page, c: readonly [number, number], halfPx: number): Promise<void> {
  await v.getByTestId("viewer2d-menu-roi").click();
  await v.getByRole("button", { name: /矩形 ROI|Rectangle ROI/ }).first().click();
  await v.waitForTimeout(300);
  await v.mouse.move(c[0] - halfPx, c[1] - halfPx);
  await v.mouse.down();
  await v.mouse.move(c[0], c[1], { steps: 6 });
  await v.mouse.move(c[0] + halfPx, c[1] + halfPx, { steps: 6 });
  await v.mouse.up();
  await v.waitForTimeout(1500);
}

async function roiLines(v: Page): Promise<string[]> {
  return (await v.evaluate(`(function () {
    var host = document.querySelector('[data-testid="viewer2d-canvas-host"]'); var out = [];
    host.querySelectorAll("svg text").forEach(function (t) {
      var sp = t.querySelectorAll("tspan");
      if (sp.length) sp.forEach(function (x) { out.push((x.textContent || "").trim()); }); else out.push((t.textContent || "").trim());
    });
    return out.filter(function (x) { return x.length > 0; });
  })()`)) as string[];
}

const meanOf = (lines: string[]): number => {
  const l = [...lines].reverse().find((x) => /平均|Mean/.test(x)) ?? ""; // 最後に描いた ROI
  const m = /(-?\d+(?:\.\d+)?)/.exec(l.replace(/^[^:：]*[:：]\s*/, ""));
  return m ? Number(m[1]) : NaN;
};

async function main(): Promise<void> {
  fs.rmSync(PHANTOM_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const py = process.env.GRAPHY_TEST_PYTHON ?? "python";
  const gen = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", "make-pet-suv-phantom.py"), PHANTOM_DIR], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`ファントムを作れませんでした: ${gen.stderr}`);
  const truth = JSON.parse(fs.readFileSync(path.join(PHANTOM_DIR, "truth.json"), "utf8"));
  const want = { tgt: truth.c_target / truth.c_ref, ref: 1, bg: truth.c_bg / truth.c_ref };

  const d = new WebDriver({ http: 18650, scp: 18651, vite: 18653 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    await resetDb(d.ports.http);
    console.log(`  import: ${JSON.stringify(await importPaths(d.ports.http, [PHANTOM_DIR])).slice(0, 100)}`);
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
    const tile = v.getByTestId("series-viewer-root").first();
    const tileBox = (await tile.boundingBox())!;
    const box = (await v.locator('[data-testid="viewer2d-canvas-host"] canvas').first().boundingBox())!;
    await v.mouse.move(tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height / 2);
    for (let i = 0; i < 25; i++) { await v.mouse.wheel(0, -100); await v.waitForTimeout(60); }
    for (let i = 0; i < 10; i++) { await v.mouse.wheel(0, 100); await v.waitForTimeout(200); }
    await v.waitForTimeout(1200);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const ppm = Math.min(box.width, box.height) / 256;
    const spots = { mid: [cx, cy], right: [cx + 40 * ppm, cy], left: [cx - 40 * ppm, cy] } as const;

    console.log("\n[1] 校正前: どこが目的・参照・背景か（濃度の順位で決める）");
    const raw: Record<string, number> = {};
    for (const [k, [x, y]] of Object.entries(spots)) raw[k] = (await cursorValue(v, x, y)).num;
    const order = Object.entries(raw).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    check(raw[order[0]] === truth.c_target && raw[order[1]] === truth.c_ref && raw[order[2]] === truth.c_bg, "3 か所の BQML 値が濃度どおり", raw);
    const tgt = spots[order[0] as keyof typeof spots];
    const ref = spots[order[1] as keyof typeof spots];
    const bg = spots[order[2] as keyof typeof spots];

    console.log("\n[2] 参照の ROI が無い → SUVR は適用できない（負例）");
    await openSuvDialog(v);
    await v.getByTestId("suv-type").selectOption("suvr");
    await v.waitForTimeout(1500);
    check(await v.getByTestId("suv-apply").isDisabled(), "適用ボタンが無効", null);
    const note0 = await v.getByTestId("suv-ref-note").innerText();
    check(/参照にできる ROI/.test(note0), "理由（参照にできる ROI がない）が出る", note0);
    check((await v.locator('[data-testid="suv-ref"] option').count()) === 0, "候補は 0 件", null);
    check(await v.getByTestId("suv-weight").isDisabled(), "体重などの SUV 用の欄は無効", null);
    await v.getByTestId("suv-dialog").getByRole("button", { name: /キャンセル|Cancel/ }).click();
    await v.waitForTimeout(400);

    console.log("\n[3] 参照球に矩形 ROI を描く → 候補に出て、平均 500 が見える");
    await drawRect(v, ref, 8 * ppm);
    await openSuvDialog(v);
    await v.getByTestId("suv-type").selectOption("suvr");
    await v.waitForTimeout(2500);
    const optN = await v.locator('[data-testid="suv-ref"] option').count();
    check(optN === 1, "候補が 1 件", optN);
    const note1 = await v.getByTestId("suv-ref-note").innerText();
    const mm = /([\d.]+)\s*(BQML|Bq)/i.exec(note1);
    check(!!mm && Math.abs(Number(mm[1]) - truth.c_ref) < 1, `参照の平均が ${truth.c_ref}（元の単位）`, note1);
    check(await v.getByTestId("suv-apply").isEnabled(), "適用ボタンが有効", null);
    await v.getByTestId("suv-apply").click();
    await v.waitForTimeout(2500);
    check(!(await v.getByTestId("suv-dialog").isVisible().catch(() => false)), "ダイアログが閉じる（適用された）", null);

    console.log("\n[4] SUVR の値（解析式: 目的 4.0・参照 1.0・背景 0.2）");
    for (const [name, spot, w] of [["目的球", tgt, want.tgt], ["参照球", ref, want.ref], ["背景", bg, want.bg]] as const) {
      const r = await cursorValue(v, spot[0], spot[1]);
      console.log(`  ${name}: ${r.text}（期待 ${w}）`);
      check(/SUVR/.test(r.text), `${name}: 単位が SUVR`, r.text);
      check(Math.abs(r.num - w) <= 0.0051, `${name}: 値が濃度の比（表示 2 桁の範囲）`, { got: r.num, want: w });
    }
    const shot = path.join(OUT_DIR, "4-viewport.png");
    fs.writeFileSync(shot, await v.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } }));
    const lum = spawnSync(py, ["-I", "-c", [
      "import sys, numpy as np; from PIL import Image",
      "a = np.array(Image.open(sys.argv[1]).convert('L')); n = a.size",
      "print(round((a >= 230).sum() / n, 4), round(((a >= 40) & (a < 200)).sum() / n, 4), int(a.max()))",
    ].join("\n"), shot], { encoding: "utf8" });
    const [bright, mid, mx] = lum.stdout.trim().split(" ").map(Number);
    console.log(`  画面: 明るい画素 ${bright} / 中間 ${mid} / 最大 ${mx}`);
    check(bright > 0.003 && mid > 0.003, "目的球が明るく・参照球が中間に見える（画素）", { bright, mid, mx });

    console.log("\n[5] 目的球に矩形 ROI → 平均 4.0。TLG（平均×体積）は出ない");
    await drawRect(v, tgt, 8 * ppm);
    const lines = await roiLines(v);
    console.log(`  ROI 脇: ${JSON.stringify(lines)}`);
    const roiMean = meanOf(lines);
    check(Math.abs(roiMean - want.tgt) < 0.02, "目的球の ROI の平均が 4.0", { roiMean, lines });
    check(lines.filter((l) => /平均|Mean/.test(l)).some((l) => /(^|[^\d.])1(\.0+)? ±/.test(l.replace(/^[^:：]*[:：]\s*/, ""))), "参照 ROI の平均は 1（参照領域が 1 になる）", lines);
    check(lines.some((l) => /SUVR/.test(l)), "ROI の統計に単位 SUVR が出る", lines);
    check(!lines.some((l) => /TLG/.test(l)), "TLG は出ない", lines);
    await v.screenshot({ path: path.join(OUT_DIR, "5-roi.png") });

    console.log("\n[6] 先に %ID/cc を掛けてから SUVR を適用しても同じ値（乗数が打ち消し合う）");
    await openSuvDialog(v);
    await v.getByTestId("suv-type").selectOption("pid");
    await v.getByTestId("suv-apply").click();
    await v.waitForTimeout(2500);
    const pidTxt = (await cursorValue(v, tgt[0], tgt[1])).text;
    check(/%ID\/cc/.test(pidTxt), "いったん %ID/cc になる", pidTxt);
    await openSuvDialog(v);
    await v.getByTestId("suv-type").selectOption("suvr");
    await v.waitForTimeout(2500);
    const note2 = await v.getByTestId("suv-ref-note").innerText();
    console.log(`  参照（%ID/cc の値）: ${note2}`);
    await v.getByTestId("suv-ref").selectOption({ index: 0 });
    await v.getByTestId("suv-apply").click();
    await v.waitForTimeout(2500);
    for (const [name, spot, w] of [["目的球", tgt, want.tgt], ["参照球", ref, want.ref], ["背景", bg, want.bg]] as const) {
      const r = await cursorValue(v, spot[0], spot[1]);
      check(/SUVR/.test(r.text) && Math.abs(r.num - w) <= 0.0051, `${name}: %ID/cc を経由しても SUVR ${w}`, r.text);
    }

    console.log("\n[7] 解除 → BQML に戻る");
    await openSuvDialog(v);
    await v.getByTestId("suv-dialog").getByRole("button", { name: /解除|Clear/ }).click();
    await v.waitForTimeout(2000);
    const back = await cursorValue(v, tgt[0], tgt[1]);
    check(/BQML/i.test(back.text) && back.num === truth.c_target, "BQML に戻る", back.text);
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

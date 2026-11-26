/*
 * DICOM-SR の表示（SeriesViewer の SrViewer）の実機検査。本物の Electron ＋ backend。
 *
 * 実行:  cd automator && npx tsx src/spike/srViewerCheck.ts
 *   CYCLE_SR_FIXTURE=<dosimetry の test/fixtures/cycleSr.real.json> PHANTOM_DIR=<GNBP-D/dicom/tp3-pt>
 *
 * 見ること:
 *   1. backend が書いた SR（dosimetry のサイクル SR ＋ `<script>` を含む SR）が、検査一覧でシリーズを開くと SeriesViewer に出る。
 *   2. 2D ビューアでも SR のタイルが出る（トーストで断らない）。
 *   3. 計測グループの表の値が、書いた値と一致する。
 *   4. 🔴 負例: 文字列に `<script>`・`<img onerror>` を含む SR でも、実行されない（window.__pwned が 0 のまま）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "sr-viewer");
const FIXTURE = process.env.CYCLE_SR_FIXTURE ?? path.join(os.homedir(), "graphy-workspace", "graphy-next-plugin-dosimetry", "test", "fixtures", "cycleSr.real.json");
const PHANTOM_DIR = process.env.PHANTOM_DIR ?? path.join(os.homedir(), "graphy-workspace", "graphy-next-plugin-dosimetry", "bench", "phantom", "GNBP-D", "dicom", "tp3-pt");
const { check, summary } = createChecker();

const EVIL = `<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 2">`;

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as { request: Record<string, unknown>; record: { vois: { label: string; doseGy: number; effectiveHalfLifeH: number }[] } };
  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    const base = `http://localhost:${driver.ports.http}`;
    const imp = (await (await fetch(`${base}/api/import/paths`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: [PHANTOM_DIR] }) })).json()) as { studyInstanceUids: string[] };
    const studyUid = imp.studyInstanceUids[0];

    // 本物の backend に SR を書かせる（dosimetry のサイクル SR と、危険な文字列を含む SR）
    const post = async (body: unknown) => {
      const r = await fetch(`${base}/api/sr/measurement-report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`SR 作成に失敗: ${r.status} ${await r.text()}`);
      return (await r.json()) as { seriesInstanceUid: string; sopInstanceUid: string };
    };
    const cycle = await post({ studyInstanceUid: studyUid, ...fx.request });
    const evil = await post({ studyInstanceUid: studyUid, seriesDescription: "Evil SR", documentTitle: EVIL, groups: [], findings: [{ label: EVIL, text: EVIL }] });
    const small = await post({ studyInstanceUid: studyUid, seriesDescription: "Small SR", documentTitle: "Small", groups: [{ trackingId: "small", measurements: [{ type: "absorbedDose", value: 0.000123456789 }] }] });

    await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${studyUid}"]`).click();

    // 1) 検査一覧: SR のシリーズを開く → SeriesViewer に SR が出る
    await page.locator(`[data-testid="series-row-${cycle.seriesInstanceUid}"]`).click();
    await page.getByTestId("sr-viewer").first().waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, "1-studylist-cycle-sr.png") });
    const head = (await page.getByTestId("sr-header").first().textContent()) ?? "";
    // タイトルは SR のルートの概念名（Imaging Measurement Report）。プラグインが付けた文書タイトルは、本文の Comment に出る。
    check(head.includes("Imaging Measurement Report") && head.includes("Comprehensive SR"), "★ 検査一覧でサイクル SR を開くと、SeriesViewer に SR が出る（タイトル・種類）", head.slice(0, 120));
    const cells = (await page.evaluate(`[...document.querySelectorAll('[data-testid="sr-group-table"]')].map(t => [...t.querySelectorAll("tbody tr")].map(tr => [...tr.children].map(c => c.textContent)))`)) as string[][][];
    check(cells.length === fx.record.vois.length, `計測グループの表が VOI の数だけある（${cells.length}）`, cells.length);
    const liver = cells[0] ?? [];
    const dose = liver.find((r) => r[0] === "Absorbed Dose");
    const teff = liver.find((r) => r[0] === "Effective Half-Life");
    check(!!dose && dose[2] === "Gy" && dose[1] === fx.record.vois[0].doseGy.toFixed(2), `★ 表の吸収線量が、書いた値と一致する（${dose?.join(" ")} / 書いた ${fx.record.vois[0].doseGy}）`, dose);
    check(!!teff && teff[2] === "h" && teff[1] === fx.record.vois[0].effectiveHalfLifeH.toFixed(2), `★ 表の有効半減期が、書いた値と一致する（${teff?.join(" ")}）`, teff);
    const tia = liver.find((r) => r[0] === "Time Integrated Activity");
    check(!!tia && tia[1] === "6.12E13", `★ 100 万以上の値は指数表記で出る（${tia?.join(" ")}）`, tia);
    const bodyText = (await page.getByTestId("sr-viewer").first().textContent()) ?? "";
    check(bodyText.includes("cycle=2;voi=liver") && bodyText.includes("dosimetry-schema: 1") && bodyText.includes("Dosimetry cycle 2 (Lu-177, 7400 MBq)"), "追跡 ID・文書タイトル・所見（サイクルのメタ情報）が読める");

    // 1 未満の値は有効数字 3 桁の指数表記で出る（固定小数だと桁が落ちる）
    await page.locator(`[data-testid="series-row-${small.seriesInstanceUid}"]`).click();
    await page.waitForFunction(() => document.body.textContent?.includes("1.23E-4"), null, { timeout: 30_000 }).catch(() => {});
    await page.screenshot({ path: path.join(OUT_DIR, "1b-studylist-small-sr.png") });
    const smallCells = (await page.evaluate(`[...document.querySelectorAll('[data-testid="sr-group-table"] tbody tr')].map(tr => [...tr.children].map(c => c.textContent))`)) as string[][];
    check(smallCells.some((r) => r[0] === "Absorbed Dose" && r[1] === "1.23E-4"), "★ 0.000123456789 Gy が表で 1.23E-4 と出る", smallCells);

    // 2) 危険な文字列の SR
    await page.locator(`[data-testid="series-row-${evil.seriesInstanceUid}"]`).click();
    await page.waitForFunction(() => document.body.textContent?.includes("window.__pwned = 1"), null, { timeout: 30_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, "2-studylist-evil-sr.png") });
    const pwned = await page.evaluate(`window.__pwned ?? 0`);
    check(pwned === 0, "★ 負例: `<script>`・`<img onerror>` を含む SR でも実行されない（window.__pwned が 0 のまま・実機）", pwned);
    check((await page.locator("sr-viewer, [data-testid=sr-viewer] script, [data-testid=sr-viewer] img").count()) === 0, "★ 危険な文字列は要素にならない（script・img が無い）");
    check(((await page.getByTestId("sr-viewer").first().textContent()) ?? "").includes("<script>window.__pwned = 1</script>"), "危険な文字列が、文字としてそのまま見える");

    // 3) 2D ビューアでも SR のタイルが出る
    await page.locator(`[data-testid="series-row-${cycle.seriesInstanceUid}"]`).click();
    await page.waitForTimeout(800);
    const viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
    await viewer.getByTestId("sr-viewer").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(800);
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-viewer2d-sr-tile.png") });
    const vText = (await viewer.getByTestId("sr-viewer").first().textContent()) ?? "";
    check(vText.includes("Imaging Measurement Report") && vText.includes("Dosimetry cycle 2") && vText.includes(fx.record.vois[0].doseGy.toFixed(2)), "★ 2D ビューアでも、SR のタイルが出る（断らない。計測の値も読める）");
    check((await viewer.getByTestId("sr-group-table").count()) === fx.record.vois.length, "2D ビューアのタイルにも、計測グループの表が出る");

    // 4) 負例: SR でないインスタンスは、理由を出す（画面が空にならない）
    const instances = (await (await fetch(`${base}/api/studies/${studyUid}/series`)).json()) as { seriesInstanceUid: string; modality: string }[];
    const pet = instances.find((s) => s.modality === "PT")!;
    const petInst = (await (await fetch(`${base}/api/studies/${studyUid}/series/${pet.seriesInstanceUid}/instances`)).json()) as { sopInstanceUid: string }[];
    const res = await fetch(`${base}/api/studies/${studyUid}/series/${pet.seriesInstanceUid}/instances/${petInst[0].sopInstanceUid}/sr`);
    check(res.status === 422, `★ 負例: PET のインスタンスの /sr は 422 で理由を返す（${res.status}）`, await res.text());
    const notFound = await fetch(`${base}/api/studies/${studyUid}/series/${pet.seriesInstanceUid}/instances/9.9.9/sr`);
    check(notFound.status === 404, `負例: 無いインスタンスは 404（${notFound.status}）`);
  } finally {
    await driver.stop().catch(() => undefined);
  }
  summary();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

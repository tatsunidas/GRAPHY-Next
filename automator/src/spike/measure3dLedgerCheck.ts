/*
 * 3D の定規（2 点間の距離）の台帳化の実機検証: 3D 窓で作った定規が患者単位ドキュメントの `measures3d` に保存され、
 * 開いたままの 2D 窓の ROI マネージャに再読込なしで出る。2D での名前・削除が 3D に戻る。3D 窓を閉じて開き直すと復元される。
 *
 * 実行:  cd automator && npx tsx src/spike/measure3dLedgerCheck.ts   （fixture ct-basic）
 *
 *   D1 3D で (0,0,0)-(30,40,0) の定規 → 距離 50.0 mm（3-4-5 の理論値）。バックエンドの measures3d に 1 件・距離は保存されない
 *   D2 2D の ROI マネージャに定規の行が出る（距離 50.0 mm）
 *   D3 2D で名前を変える → 3D の台帳に反映
 *   D4 2D で削除 → 3D から消え、バックエンドの deleted に載る
 *   D5 3D で 2 本目を作る → 3D 窓を閉じる（シーン破棄）→ 墓標は出ない → 開き直すと復元される（D4 で消したものは復活しない）
 *   N1 別患者のドキュメントは空のまま
 * ⚠ 3D 窓の表面ピック（実機のドラッグ）は通さず、台帳へ直接作る（DEV の seedMeasure3D）。実機の使い勝手はユーザー確認。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "measure3d-ledger-check");
const { check, summary } = createChecker();

const rows2d = (v: Page) => v.locator('[data-testid="ruler-row"]');
type Doc = { measures3d?: Array<Record<string, unknown>>; deleted?: Array<{ roiUid: string }> };
async function readDoc(port: number, pk: string): Promise<Doc | null> {
  const r = await fetch(`http://127.0.0.1:${port}/api/rois?patientKey=${encodeURIComponent(pk)}`);
  if (!r.ok) return null;
  const d = (await r.json()) as { json: string | null };
  return d.json ? (JSON.parse(d.json) as Doc) : {};
}
const list3d = (p: Page) => p.evaluate(`window.__graphyDebug.listMeasures3D()`) as Promise<Array<{ id: string; label?: string; distMm: number }>>;

async function open3d(d: DesktopDriver, main: Page): Promise<Page> {
  const w = await d.waitForNewPage(() => main.locator('button[title="3D Viewer"]').click(), (url) => url.includes("viewer3d"));
  await w.locator('[data-testid="viewer3d-mode-slab"]').waitFor({ timeout: 180_000 });
  await w.waitForTimeout(5_000);
  return w;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver();
  await d.start();
  const port = d.ports.http;
  try {
    await resetDb(port);
    await importFixtureCategory(port, "ct-basic");
    const main = d.page;
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await openFirstSeriesInViewer(main, createStepRecorder());
    const v = await d.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await v.waitForTimeout(3000);
    if (!(await v.getByTestId("roi-new-painted").isVisible().catch(() => false))) {
      await v.getByTestId("viewer2d-menu-roiTools").click();
      await v.getByText(/^(ROI マネージャ|ROI manager)$/i).first().click();
      await v.waitForTimeout(500);
    }
    const ctx = (await v.evaluate(`window.__graphyDebug.currentRoiContext()`)) as { patientKey: string } | null;
    check(!!ctx?.patientKey, "2D 窓の患者キーが取れる", ctx);
    const pk = ctx!.patientKey;
    let w = await open3d(d, main);
    check((await list3d(w)).length === 0, "前提: 3D の台帳に定規が 0 件");
    check((await rows2d(v).count()) === 0, "前提: 2D の定規の行が 0 件");

    console.log("\n[D1] 3D で定規を作る");
    const id1 = (await w.evaluate(`window.__graphyDebug.seedMeasure3D([0,0,0],[30,40,0])`)) as string;
    const l1 = await list3d(w);
    check(l1.length === 1 && Math.abs(l1[0].distMm - 50) < 1e-9, "距離は 3-4-5 の理論値 50 mm", l1);
    await w.waitForTimeout(3500);
    const doc1 = await readDoc(port, pk);
    check((doc1?.measures3d?.length ?? 0) === 1, "バックエンドの measures3d に 1 件保存", doc1);
    check(!!doc1?.measures3d?.[0] && !("distMm" in doc1.measures3d[0]), "距離は保存されない（端点だけ）");

    console.log("\n[D2] 2D の ROI マネージャに出る（再読込なし）");
    await v.waitForTimeout(1500);
    check((await rows2d(v).count()) === 1, "2D に定規の行が 1 行");
    const dist = ((await rows2d(v).getByTestId("ruler-distance").textContent()) ?? "").trim();
    check(dist === "50.0 mm", "2D の距離表示が 50.0 mm", dist);
    await v.screenshot({ path: path.join(OUT_DIR, "2d-ruler-row.png") });

    console.log("\n[D3] 2D で名前 → 3D に反映");
    await rows2d(v).getByTestId("solid-name").fill("lesion-width");
    await w.waitForTimeout(4000);
    const l3 = await list3d(w);
    check(l3[0]?.label === "lesion-width", "3D の台帳の名前が 2D で付けたもの", l3);

    console.log("\n[D4] 2D で削除 → 3D から消える");
    await rows2d(v).getByTestId("ruler-delete").click();
    await w.waitForTimeout(4000);
    check((await list3d(w)).length === 0, "3D の台帳から消える");
    const doc4 = await readDoc(port, pk);
    check((doc4?.deleted ?? []).some((t) => t.roiUid === id1) && (doc4?.measures3d?.length ?? 0) === 0, "deleted に載り measures3d は空", doc4);

    console.log("\n[D5] 3D 窓を閉じて開き直す");
    const id2 = (await w.evaluate(`window.__graphyDebug.seedMeasure3D([0,0,0],[0,0,12])`)) as string;
    await w.waitForTimeout(3500);
    await w.screenshot({ path: path.join(OUT_DIR, "3d-before-close.png") });
    await w.close();
    await v.waitForTimeout(1500);
    const doc5 = await readDoc(port, pk);
    check((doc5?.measures3d ?? []).some((m) => m.id === id2), "閉じた後も保存に定規が残る");
    check(!(doc5?.deleted ?? []).some((t) => t.roiUid === id2), "シーン破棄で墓標は出ない（削除ではない）", doc5?.deleted);
    w = await open3d(d, main);
    const l5 = await list3d(w);
    check(l5.length === 1 && l5[0].id === id2 && Math.abs(l5[0].distMm - 12) < 1e-9, "開き直すと 2 本目（12 mm）だけが復元され、削除済みは復活しない", l5);
    check((await rows2d(v).count()) === 1, "2D の行も 1 行のまま");

    console.log("\n[N1] 負例: 別患者");
    const other = await readDoc(port, "OTHER-PATIENT");
    check(other === null || JSON.stringify(other) === "{}", "別患者のドキュメントは空のまま", other);
    await w.close().catch(() => {});
    await v.close().catch(() => {});
  } finally {
    await d.stop();
  }
  process.exitCode = summary() ? 1 : 0;
}

void main();

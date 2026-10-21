/*
 * [pluginRois3dCheck] プラグインへ渡す 3D ROI（台帳の箱と 3D 定規）の実機検証。DEV の readRois3D は host の getRois3d と同じ読み出し関数。
 *   P1 2D 窓で箱 40×30×20 mm → 体積 24 mL・中心・サイズが理論値と一致
 *   P2 3D 窓で 3-4-5 の定規 → 2D 窓の読み出しに再読込なしで増え distanceMm=50
 *   （3D 窓は solid を読み込まない作りなので、3D 窓での箱の読み出しは検査しない＝G4b の範囲・未達）
 *   P4 2D で箱を削除 → 読み出しから消える
 *   N1 別患者のドキュメントは空
 * ⚠ host の getRois3d への 3 層の委譲（Toolbar→MenuBar→Screen）は実プラグイン経由では通していない（未達）。
 *
 * （元: 3D の定規（2 点間の距離）の台帳化の実機検証: 3D 窓で作った定規が患者単位ドキュメントの `measures3d` に保存され、
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "plugin-rois3d-check");
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
  type R = { kind: string; id: string; volumeMl?: number; center?: number[]; size?: number[]; shape?: string; distanceMm?: number; patientKey: string | null; seriesUid: string | null };
  const read = (p: Page) => p.evaluate(`window.__graphyDebug.readRois3D()`) as Promise<R[]>;
  const until = async (p: Page, f: (r: R[]) => boolean, ms = 15_000) => {
    const t0 = Date.now();
    let r = await read(p);
    while (!f(r) && Date.now() - t0 < ms) {
      await p.waitForTimeout(300);
      r = await read(p);
    }
    return r;
  };
  try {
    await resetDb(port);
    await importFixtureCategory(port, "ct-basic");
    const main = d.page;
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await openFirstSeriesInViewer(main, createStepRecorder());
    const v = await d.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await v.waitForTimeout(3000);
    const ctx = (await v.evaluate(`window.__graphyDebug.currentRoiContext()`)) as { patientKey: string; seriesUid: string } | null;
    check(!!ctx?.patientKey, "2D 窓の患者キーが取れる", ctx);
    check((await read(v)).length === 0, "前提: 読み出しが 0 件");

    console.log("\n[P1] 2D 窓で箱");
    const boxId = (await v.evaluate(`window.__graphyDebug.seedBox3D([10,20,30],[40,30,20])`)) as string;
    const r1 = await read(v);
    const b = r1.find((r) => r.id === boxId);
    check(r1.length === 1 && b?.kind === "solid" && b.shape === "box", "箱が 1 件 solid/box で読める", r1);
    check(Math.abs((b?.volumeMl ?? 0) - 24) < 1e-12, "体積は 40×30×20 mm³ = 24 mL", b?.volumeMl);
    check(JSON.stringify(b?.center) === "[10,20,30]" && JSON.stringify(b?.size) === "[40,30,20]", "中心・全長が入力どおり（LPS mm）", b);
    check(b?.seriesUid === ctx!.seriesUid, "seriesUid が現在のシリーズ", b?.seriesUid);

    console.log("\n[P2] 3D 窓の定規が再読込なしで 2D の読み出しに増える");
    const w = await open3d(d, main);
    await w.evaluate(`window.__graphyDebug.seedMeasure3D([0,0,0],[30,40,0])`);
    const r2 = await until(v, (r) => r.some((x) => x.kind === "ruler3d"));
    const ru = r2.find((x) => x.kind === "ruler3d");
    check(r2.length === 2 && Math.abs((ru?.distanceMm ?? 0) - 50) < 1e-9, "定規が増え distanceMm = 50（3-4-5）", r2);

    console.log("\n[P4] 箱を 2D 窓で削除");
    await v.evaluate(`window.__graphyDebug.removeRoi3D("${boxId}")`);
    const r4 = await read(v);
    check(r4.length === 1 && r4[0].kind === "ruler3d", "箱が消え定規だけが残る", r4);
    console.log("\n[N1] 負例: 別患者");
    const otherRes = await fetch(`http://127.0.0.1:${port}/api/rois?patientKey=OTHER-PATIENT`);
    const other = otherRes.ok ? ((await otherRes.json()) as { json: string | null }).json : null;
    check(!otherRes.ok || other === null || other === "{}", "別患者のドキュメントは空", other);
    await w.close().catch(() => {});
    await v.close().catch(() => {});
  } finally {
    await d.stop();
  }
  process.exitCode = summary() ? 1 : 0;
}

void main();

/*
 * 球 ROI を台帳の楕円体 solid に統合した変更（保存・復元・削除・焼き込み・MPR 由来の箱の表示）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/solidUnifyCheck.ts   （fixture ct-basic）
 * 専用ポート: GRAPHY_AUTOMATOR_HTTP_PORT / _SCP_PORT / _VITE_PORT。
 *
 * ⚠ 球は DEV 限定の `__graphyDebug.seedSphere3D` で作る（円 ROI からの作成ボタンは検査できていない）。
 *   「MPR で作った箱」は MPR を操作せず、同じ形式の solid を保存 API へ直接書いて代用する（表示側の検査）。
 * 流れ:
 *   S1 球を作る → 保存先ドキュメント（schema 1・solids 1 件・径 20×20×20・シリーズ UID が窓のもの）
 *   S2 負例: 別患者のドキュメントには出ない
 *   S3 閉じて開き直す → 球の行・半径 10・断面プレビューが復元される
 *   S4 復元した球を焼き込む → 体積が旧実装の基準値（3924 mm³、同じ球・同じ格子）と一致
 *   S5 削除 → 保存先に solids 0 件＋墓標、開き直しても復活しない
 *   S6 MPR 由来の箱（径が等しくない・refImageId なし）を保存先へ書く → 開くと行にサイズ欄、4 点の矩形プレビュー、焼き込みは無効
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "solid-unify-check");
const { check, summary } = createChecker();
const R = 10;
const BASELINE_VOL = 3924; // 旧実装（球ストア）で同じ球・同じ格子を焼いた体積（mm³）

interface Doc { schema: number; rois: unknown[]; solids?: Array<{ id: string; shape: string; size: number[]; seriesUid?: string; refImageId?: string }>; deleted?: Array<{ roiUid: string }> }
interface Dto { json: string | null; version: number | null }

async function dto(port: number, pk: string): Promise<Dto> {
  const res = await fetch(`http://127.0.0.1:${port}/api/rois?patientKey=${encodeURIComponent(pk)}`);
  if (!res.ok) throw new Error(`GET /api/rois ${res.status}`);
  return (await res.json()) as Dto;
}
const docOf = async (port: number, pk: string): Promise<Doc | null> => {
  const d = await dto(port, pk);
  return d.json ? (JSON.parse(d.json) as Doc) : null;
};

async function readGeo(page: Page): Promise<{ origin: number[]; spacing: number[]; dims: number[]; dir: number[] }> {
  return page.evaluate(`(function () {
    var g = window.__graphyDebug.getViewportGeometry()[0].image;
    return { origin: Array.from(g.origin), spacing: Array.from(g.spacing), dims: Array.from(g.dimensions), dir: Array.from(g.direction) };
  })()`) as Promise<{ origin: number[]; spacing: number[]; dims: number[]; dir: number[] }>;
}

async function openViewer(d: DesktopDriver, first = false): Promise<Page> {
  const main = d.page;
  // 2 回目以降は、メイン窓で選択済みのシリーズをそのまま開き直す。
  if (first) {
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await openFirstSeriesInViewer(main, createStepRecorder());
  }
  const v = await d.waitForNewPage(
    () => main.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await v.waitForTimeout(3000);
  const slider = v.getByTestId("dim-slider-z");
  const mid = Math.floor((Number(await slider.getAttribute("min")) + Number(await slider.getAttribute("max"))) / 2);
  await slider.fill(String(mid));
  await v.waitForTimeout(400);
  if (!(await v.getByTestId("roi-new-painted").isVisible().catch(() => false))) {
    await v.getByTestId("viewer2d-menu-roiTools").click();
    await v.getByText(/^(ROI マネージャ|ROI manager)$/i).first().click();
    await v.waitForTimeout(500);
  }
  return v;
}

const rows = (v: Page) => v.locator('[data-testid="roi-row"][data-kind="sphere"]');
async function previewPoints(v: Page): Promise<number | null> {
  return v.evaluate(`(function () {
    var c = document.querySelector('[data-testid="sphere-preview"]');
    return c && c.tagName.toLowerCase() === "polygon" ? c.getAttribute("points").split(" ").length : null;
  })()`) as Promise<number | null>;
}
async function bakedVolume(v: Page): Promise<number> {
  await v.getByTestId("sphere-bake").click();
  await v.waitForTimeout(2500);
  await v.getByTestId("mask-stats-run").click();
  await v.getByTestId("mask-stats").waitFor({ state: "visible", timeout: 30_000 });
  const text = (await v.getByTestId("mask-stats").textContent()) ?? "";
  const m = /\(([\d,]+)\s*mm³\)/.exec(text);
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver();
  await d.start();
  const port = d.ports.http;
  try {
    await resetDb(port);
    await importFixtureCategory(port, "ct-basic");
    let v = await openViewer(d, true);
    v.on("console", (m) => { if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`); });

    const ctx = (await v.evaluate(`window.__graphyDebug.currentRoiContext()`)) as { patientKey: string; seriesUid: string } | null;
    check(!!ctx?.patientKey && !!ctx?.seriesUid, "窓の患者キーとシリーズ UID が取れる", ctx);
    if (!ctx) throw new Error("no context");
    const geo = await readGeo(v);
    const c0 = [0, 1, 2].map((i) => geo.origin[i] + geo.dir[i] * geo.spacing[0] * geo.dims[0] / 2 + geo.dir[3 + i] * geo.spacing[1] * geo.dims[1] / 2);

    console.log("\n[S1] 球を作る → 保存");
    check((await docOf(port, ctx.patientKey)) === null, "操作前は保存先が空（対象が実在するための前提）");
    await v.evaluate(`window.__graphyDebug.seedSphere3D(${JSON.stringify(c0)}, ${R})`);
    await v.waitForTimeout(500);
    check((await rows(v).count()) === 1, "球の行が 1 行できる");
    await v.waitForTimeout(2500);
    const doc1 = await docOf(port, ctx.patientKey);
    check(doc1?.schema === 1 && doc1.solids?.length === 1, "保存: schema 1・solids 1 件", doc1);
    check(JSON.stringify(doc1?.solids?.[0]?.size) === JSON.stringify([2 * R, 2 * R, 2 * R]) && doc1?.solids?.[0]?.shape === "ellipsoid", "径が 20×20×20 の楕円体", doc1?.solids?.[0]);
    check(doc1?.solids?.[0]?.seriesUid === ctx.seriesUid, "シリーズ UID が窓のもの", doc1?.solids?.[0]?.seriesUid);
    const sphereId = doc1?.solids?.[0]?.id ?? "";

    console.log("\n[S2] 負例: 別患者");
    check((await docOf(port, "OTHER-PATIENT")) === null, "別患者のドキュメントには出ない");

    console.log("\n[S3] 閉じて開き直す → 復元");
    await v.close();
    v = await openViewer(d);
    await v.waitForTimeout(1500);
    check((await rows(v).count()) === 1, "球の行が復元される");
    check((await v.getByTestId("sphere-radius").inputValue()) === "10.0" || Number(await v.getByTestId("sphere-radius").inputValue()) === R, "半径が 10");
    check((await previewPoints(v)) === 64, "中間スライスに断面プレビュー（64 点の多角形）が出る", await previewPoints(v));
    await v.screenshot({ path: path.join(OUT_DIR, "restored.png") });

    console.log("\n[S4] 復元した球の焼き込み");
    const vol = await bakedVolume(v);
    console.log(`  vol=${vol} baseline=${BASELINE_VOL}`);
    check(vol === BASELINE_VOL, "焼き込み体積が旧実装の基準値と一致", { vol, BASELINE_VOL });

    console.log("\n[S5] 削除 → 復活しない");
    await rows(v).getByTestId("roi-row-delete").click(); // 焼き込みで増えた塗りの行の削除ボタンと取り違えない
    await v.waitForTimeout(3000);
    const doc2 = await docOf(port, ctx.patientKey);
    check((doc2?.solids?.length ?? -1) === 0, "保存先の solids が 0 件", doc2?.solids);
    check((doc2?.deleted ?? []).some((x) => x.roiUid === sphereId), "墓標が立つ", doc2?.deleted);
    await v.close();
    v = await openViewer(d);
    await v.waitForTimeout(1500);
    check((await rows(v).count()) === 0, "開き直しても復活しない");

    console.log("\n[S6] MPR 由来の箱（径が不等・refImageId なし）");
    const cur = await dto(port, ctx.patientKey);
    const base = JSON.parse(cur.json ?? "{}") as Doc;
    const box = { id: "mpr-made-box", shape: "box", center: c0, size: [30, 20, 12], seriesUid: ctx.seriesUid, label: "Box", color: "#ff8800" };
    const body = JSON.stringify({ ...base, schema: 1, solids: [box] });
    const put = await fetch(`http://127.0.0.1:${port}/api/rois?patientKey=${encodeURIComponent(ctx.patientKey)}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json: body, roiCount: (base.rois ?? []).length, version: cur.version }),
    });
    check(put.ok, "保存先へ箱を書く（2xx）", put.status);
    await v.close();
    v = await openViewer(d);
    await v.waitForTimeout(1500);
    check((await rows(v).count()) === 1, "箱の行が出る");
    check((await v.getByTestId("sphere-radius").count()) === 0, "等軸でないので半径欄は出ない");
    const sx = await v.getByTestId("solid-size-x").inputValue();
    const sy = await v.getByTestId("solid-size-y").inputValue();
    const sz = await v.getByTestId("solid-size-z").inputValue();
    check(Number(sx) === 30 && Number(sy) === 20 && Number(sz) === 12, "サイズ欄が 30/20/12", [sx, sy, sz]);
    check((await previewPoints(v)) === 4, "中間スライスの断面は 4 点の矩形", await previewPoints(v));
    check(await v.getByTestId("sphere-bake").isDisabled(), "refImageId が無いので焼き込みは無効");
    await v.screenshot({ path: path.join(OUT_DIR, "box.png") });
    await v.close().catch(() => {});
  } finally {
    await d.stop();
  }
  process.exitCode = summary() ? 1 : 0;
}

void main();

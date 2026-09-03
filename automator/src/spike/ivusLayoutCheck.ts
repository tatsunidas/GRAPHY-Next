/*
 * IVUS プルバックが「フレーム軸」で開けることの実機検証 — `fw/angio-design.md` §12 / A8。
 *
 * 実行:  cd automator && npx tsx src/spike/ivusLayoutCheck.ts
 *
 * <h3>何を確かめるのか</h3>
 * A8 の同期ロジックより前に、**取り込んだ pullback が全フレーム見えること**を確かめる。
 * ここが塞がっていると（`SeriesLayoutAssembler` が IVUS を展開しないと）
 * **1 枚は表示されるので壊れて見えないまま、先頭フレームしか出ない**。
 * これは XA でまったく同じ壊れ方をした経路で、単体テストだけでは
 * 「Assembler から呼ばれているか」までしか守れないため、実機で通す。
 *
 * <h3>⚠️ 合成ファントムである</h3>
 * `bench/make_phantom_ivus.py` の GNBP-IVUS。**実 IVUS のリングダウン・ガイドワイヤ影・
 * 非一様な引き抜き・心拍による前後動は含んでいない。**「合成で通った」は
 * 「実データで通る」を意味しない。
 *
 * 🚨 走らせる前に `.results/ivus-layout` を消す（失敗した実行が前回の成果物を持ち帰る）。
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs, findBlockingOverlay } from "../common/dismissDialogs.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "ivus-layout");
const PHANTOM_DIR = path.join(AUTOMATOR_ROOT, "..", "bench", "phantom", "GNBP-IVUS");
const TRUTH_PATH = path.join(PHANTOM_DIR, "truth.json");

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  const d = detail === undefined ? "" : ` — ${JSON.stringify(detail)}`;
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${d}`);
  } else {
    console.log(`  [FAIL] ${label}${d}`);
    failures.push(label);
  }
}

interface Truth {
  file: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  frameCount: number;
  frameRate: number;
  pullbackRateMmPerS: number;
  pullbackStartFrame: number;
  pullbackStopFrame: number;
  markers: { distanceMm: number; frame: number; frameOneBased: number }[];
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(TRUTH_PATH)) {
    throw new Error(
      `IVUS ファントムがありません: ${TRUTH_PATH}` +
        `（cd bench && python3 make_phantom_ivus.py --out ./phantom）`,
    );
  }
  const truth = JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8")) as Truth;

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);

    // ── 1. 取り込み ────────────────────────────────────────────────
    const imp = await importPaths(driver.ports.http, [path.join(PHANTOM_DIR, truth.file)]);
    check(imp.imported === 1, "[1] ★IVUS（US Multi-frame / Modality=IVUS）を取り込める", imp);

    // ── 2. レイアウト（ここが A8 の最初の関門）─────────────────────
    const layoutRes = await fetch(
      `http://127.0.0.1:${driver.ports.http}/api/studies/${truth.studyInstanceUid}` +
        `/series/${truth.seriesInstanceUid}/layout`,
    );
    check(layoutRes.ok, "[2] レイアウトを取得できる", { status: layoutRes.status });
    const layout = (await layoutRes.json()) as {
      nZ: number;
      nC: number;
      nT: number;
      cells: unknown[];
      axes?: { stackAxis?: string; z?: { label?: string }; t?: { label?: string } };
    };
    fs.writeFileSync(path.join(OUT_DIR, "layout.json"), JSON.stringify(layout, null, 2));

    // 🔴 これが本命。展開されていないと nT=1（先頭フレームだけ）になる。
    check(
      layout.nT === truth.frameCount,
      "[2] ★全フレームがフレーム軸に載っている（先頭 1 枚で終わっていない）",
      { nT: layout.nT, expected: truth.frameCount },
    );
    check(layout.nZ === 1, "[2] 1 プルバック = Z 1 枚", { nZ: layout.nZ });
    check(
      layout.axes?.stackAxis === "t",
      "[2] ★スタックはフレーム軸（送るたびに setStack しない）",
      { stackAxis: layout.axes?.stackAxis },
    );
    check(layout.cells.length === truth.frameCount, "[2] セル数がフレーム数と一致", {
      cells: layout.cells.length,
    });

    // ── 3. プルバックのタグが読める ────────────────────────────────
    // 🔑 §12.2 の対応づけ（フレーム → 距離）に必要なタグが**実際に入っているか**。
    //    ここが空だと「距離が出せない」ので、同期の実装に入る前に確かめる。
    const sopRes = await fetch(
      `http://127.0.0.1:${driver.ports.http}/api/studies/${truth.studyInstanceUid}` +
        `/series/${truth.seriesInstanceUid}/instances`,
    );
    const instances = (await sopRes.json()) as { sopInstanceUid: string }[];
    check(instances.length === 1, "[3] インスタンスは 1 本", { n: instances.length });
    const tagsRes = await fetch(
      `http://127.0.0.1:${driver.ports.http}/api/studies/${truth.studyInstanceUid}` +
        `/series/${truth.seriesInstanceUid}/instances/${instances[0].sopInstanceUid}/tags`,
    );
    const tags = (await tagsRes.json()) as Record<string, { value?: unknown }> | Record<string, unknown>;
    fs.writeFileSync(path.join(OUT_DIR, "tags.json"), JSON.stringify(tags, null, 2));
    const flat = JSON.stringify(tags);
    for (const [name, expected] of [
      ["IVUSPullbackRate", String(truth.pullbackRateMmPerS)],
      ["IVUSPullbackStartFrameNumber", String(truth.pullbackStartFrame)],
      ["IVUSPullbackStopFrameNumber", String(truth.pullbackStopFrame)],
    ] as const) {
      check(flat.includes(name), `[3] タグ ${name} が読める`, { expected });
    }

    // ── 4. 画面で全フレームが送れる ────────────────────────────────
    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    const blocked = await findBlockingOverlay(mainPage, "search-submit-button");
    if (blocked) throw new Error(`クリックが塞がれています: ${blocked}`);
    const dates = mainPage.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await mainPage.getByTestId("search-submit-button").click();
    await mainPage.getByTestId(`study-row-${truth.studyInstanceUid}`).click();
    await mainPage.locator('[data-testid^="series-row-"]').first().click();

    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(4_000);

    const indicator = await viewer
      .getByTestId("cine-indicator")
      .textContent()
      .catch(() => null);
    const m = indicator ? /(\d+)\s*\/\s*(\d+)/.exec(indicator) : null;
    check(
      !!m && Number(m[2]) === truth.frameCount,
      "[4] ★画面のフレーム表示が全フレーム数を示す",
      { indicator, expected: truth.frameCount },
    );

    // 実際に画素が描かれていること（レイアウトだけ合っていて真っ黒、を避ける）。
    const stats = (await viewer.evaluate(`(() => {
      const g = window.__graphyDebug;
      const s = g && g.getPixelStats ? g.getPixelStats() : null;
      return s ? JSON.stringify(s) : null;
    })()`)) as string | null;
    const px = stats ? (JSON.parse(stats) as { nonBlackFraction: number }[]) : [];
    check(
      px.length > 0 && px[0].nonBlackFraction > 0.1,
      "[4] 断層が実際に描画されている（レイアウトだけ合って真っ黒、ではない）",
      px[0],
    );

    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer.png") }).catch(() => {});
  } finally {
    await driver.stop().catch(() => {});
  }

  console.log(`\n===== IVUS プルバックのレイアウト（A8 の前提）実機検証 =====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

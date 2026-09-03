/*
 * 胎児心エコー動画（US Multi-frame / H.264）を取り込んで開けるかの実機検証。
 * `fw/uvs-plugin-design.md` §9 の段 1。
 *
 * 実行:  cd automator && npx tsx src/spike/usVideoImportCheck.ts [--dicom PATH]
 *
 * <h3>何を確かめるのか</h3>
 * プラグインを作る前に、**入力データが本体で扱えるのか**を確定させる。設計 §3 で
 * 「2 段構えで塞がっている」と書いた見立てを、**実機で事実にする**のが目的:
 *
 *   ① Modality=US のマルチフレームが**フレーム軸に展開されない**（レイアウトで確認）
 *   ② 展開しても **Cornerstone が H.264 を解けない**（表示で確認）
 *
 * 🔑 **「開けない」ことが分かるのも成果である。** ここが塞がっているなら、プラグインは
 * backend 面で ffmpeg からフレームを取る設計になる（§3.2）——**先に確かめておかないと、
 * フロントで読める前提の実装を書いてしまう**。
 *
 * 🚨 走らせる前に `.results/us-video-import` を消す。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs, findBlockingOverlay } from "../common/dismissDialogs.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "us-video-import");
const DEFAULT_DICOM = path.join(os.homedir(), "graphy_sample_images", "uvs", "HLHS-600.dcm");

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
/** 「分かればよい」観測（合否ではない）。設計の見立てを事実にするためのもの。 */
function observe(label: string, detail: unknown): void {
  console.log(`  [観測] ${label} — ${JSON.stringify(detail)}`);
}

function argValue(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dicom = argValue("dicom") ?? DEFAULT_DICOM;
  if (!fs.existsSync(dicom)) {
    throw new Error(
      `サンプルがありません: ${dicom}\n` +
        `先に scripts/wrap-video-as-us-multiframe.py で作ってください。`,
    );
  }

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);

    // ── 1. 取り込み ────────────────────────────────────────────────
    const imp = await importPaths(driver.ports.http, [dicom]);
    check(imp.imported === 1, "[1] ★US Multi-frame（H.264）を取り込める", imp);
    if (imp.imported !== 1) throw new Error("取り込めませんでした");

    const studies = (await (
      await fetch(`http://127.0.0.1:${driver.ports.http}/api/studies`)
    ).json()) as { studyInstanceUid: string }[];
    const studyUid = studies[0].studyInstanceUid;
    const series = (await (
      await fetch(`http://127.0.0.1:${driver.ports.http}/api/studies/${studyUid}/series`)
    ).json()) as { seriesInstanceUid: string; modality: string | null; sopClassUid: string | null }[];
    check(series.length === 1, "[1] シリーズが 1 本できる", series.length);
    check(series[0].modality === "US", "[1] Modality=US として索引される", series[0]);

    // ── 2. レイアウト（設計 §3 の①を事実にする）────────────────────
    const layout = (await (
      await fetch(
        `http://127.0.0.1:${driver.ports.http}/api/studies/${studyUid}` +
          `/series/${series[0].seriesInstanceUid}/layout`,
      )
    ).json()) as { nZ: number; nT: number; axes?: { stackAxis?: string } };
    fs.writeFileSync(path.join(OUT_DIR, "layout.json"), JSON.stringify(layout, null, 2));
    // 🔑 ここは**合否ではなく観測**。設計は「展開されない（nT=1）」と見立てている。
    observe("[2] レイアウト（設計は nT=1 と見立てている）", {
      nZ: layout.nZ,
      nT: layout.nT,
      stackAxis: layout.axes?.stackAxis,
    });

    // ── 3. 画面で開けるか（設計 §3 の②）───────────────────────────
    await waitForMainScreenReady(mainPage, 60_000);
    await dismissStartupDialogs(mainPage);
    const blocked = await findBlockingOverlay(mainPage, "search-submit-button");
    if (blocked) throw new Error(`クリックが塞がれています: ${blocked}`);
    const dates = mainPage.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await mainPage.getByTestId("search-submit-button").click();
    await mainPage.getByTestId(`study-row-${studyUid}`).click();
    await mainPage.locator('[data-testid^="series-row-"]').first().click();

    const viewer = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer") || url.includes("video"),
    );
    await viewer.waitForTimeout(6_000);
    observe("[3] 開いたウィンドウの URL", viewer.url());

    // 画素が出ているか（真っ黒＝デコードできていない）。
    const stats = (await viewer.evaluate(`(() => {
      const g = window.__graphyDebug;
      const s = g && g.getPixelStats ? g.getPixelStats() : null;
      return s ? JSON.stringify(s) : null;
    })()`)) as string | null;
    const px = stats ? (JSON.parse(stats) as { nonBlackFraction: number }[]) : [];
    observe("[3] 画素統計（0 なら Cornerstone が H.264 を解けていない）", px[0] ?? null);

    // 動画として開かれた場合は <video> があるはず。
    const hasVideo = await viewer
      .locator("video")
      .count()
      .catch(() => 0);
    observe("[3] <video> 要素の数（動画経路で開いたか）", hasVideo);

    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer.png") }).catch(() => {});

    // ── 4. backend からフレームを取れるか（プラグインが使う経路）────
    // 🔑 設計 §3.2 の前提。**ここが通るなら、フロントで読めなくてもプラグインは作れる。**
    const instances = (await (
      await fetch(
        `http://127.0.0.1:${driver.ports.http}/api/studies/${studyUid}` +
          `/series/${series[0].seriesInstanceUid}/instances`,
      )
    ).json()) as { sopInstanceUid: string }[];
    const sop = instances[0].sopInstanceUid;
    const meta = await fetch(
      `http://127.0.0.1:${driver.ports.http}/api/instances/${sop}/video-metadata`,
    );
    observe("[4] /video-metadata の応答", { status: meta.status });
    if (meta.ok) {
      const body = await meta.json();
      fs.writeFileSync(path.join(OUT_DIR, "video-metadata.json"), JSON.stringify(body, null, 2));
      observe("[4] ★動画メタデータ（プラグインが fps とフレーム数を得る口）", body);
    }
    const rendered = await fetch(
      `http://127.0.0.1:${driver.ports.http}/api/instances/${sop}/rendered`,
      { method: "HEAD" },
    );
    check(
      rendered.ok || rendered.status === 200 || rendered.status === 206,
      "[4] ★/rendered から MP4 を取り出せる（プラグインのフレーム供給の土台）",
      { status: rendered.status, type: rendered.headers.get("content-type") },
    );
  } finally {
    await driver.stop().catch(() => {});
  }

  console.log(`\n===== US 動画の取り込み（UVS 段 1）実機検証 =====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

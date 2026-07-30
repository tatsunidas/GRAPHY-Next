/*
 * **重い外部プラグイン**を丸ごと通す実機検証スパイク（検体は CADe プラグイン
 * "Aneurysm Detector"。プラグイン本体はこのリポジトリの外にある）。
 *
 * `hostApiCheck.ts` との住み分け:
 *   あちらは host API の**契約**（返り値の形・毎回読み直すか・境界条件）を、専用の極小
 *   プラグインで網羅的に確かめる。こちらは逆に、**実在する重いプラグイン 1 本を最初から最後まで
 *   動かして、契約が実用に耐えるか**を見る。具体的に増える検証は次の 3 つ:
 *     - `getPixelData()` を **1 スライスずつ 256 回**呼んでシリーズ全体を再構成できるか
 *       （抜け・取り違え・spacing の欠落が無いか。単発呼び出しでは出ない不具合が出る）
 *     - レンダラの Worker で **分オーダーの計算**を回している間、本体の UI が壊れないか
 *     - `showOverlay()` の結果が**画として実際に変わる**か（要素の有無ではなく画素で見る）
 *
 * 実行（プラグイン側で `npm run build` 済みであること）:
 *   cd automator && npx tsx src/spike/aneurysmPluginCheck.ts \
 *     --plugin=<プラグインリポジトリのパス> \
 *     --dicom=<DICOM ディレクトリ> \
 *     [--truth=x,y,z]
 *
 * `--truth` は「そこに病変があると分かっている」ボクセル座標で、検出できたかの判定に使う。
 * 省略すると検出の当たり判定だけを飛ばし、他の項目は実行する。
 *
 * 検体に使った公開データ: AneuriskWeb の C0005（3D-RA・256^3・0.349mm 等方・ICA 側壁瘤）。
 * この症例なら `--truth=110,111,115`。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "aneurysm-plugin-check");
const PLUGIN_ID = "aneurysm-detector";

/** 同一病変とみなす距離（ボクセル）。0.349mm 等方なら 12 voxel ≒ 4mm。 */
const TRUTH_TOLERANCE = 12;

interface CandidateSummary {
  id: number;
  score: number;
  maxBulgeRatio: number;
  maxShapeIndex: number;
  peakRadiusMm: number;
  maxWallDistanceMm: number;
  volumeMm3: number;
  sphericity: number;
  peakPoint: { x: number; y: number; z: number };
  type: string;
}

interface DebugSummary {
  at: string;
  dims: [number, number, number];
  spacing: [number, number, number];
  thresholdUsed: number;
  foregroundVoxels: number;
  whiteTopHatApplied: boolean;
  branchCount: number;
  nodeCount: number;
  totalLengthMm: number;
  meshVertices: number;
  meshTriangles: number;
  timingsMs: Record<string, number>;
  candidates: CandidateSummary[];
}

function arg(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const USAGE = [
  "使い方:",
  "  npx tsx src/spike/aneurysmPluginCheck.ts \\",
  "    --plugin=<プラグインリポジトリのパス（dist/ui.js がビルド済みであること）> \\",
  "    --dicom=<DICOM ディレクトリ> \\",
  "    [--truth=x,y,z]   既知病変のボクセル座標（検出できたかの判定に使う）",
  "",
  "検体に使った公開データ AneuriskWeb C0005 なら --truth=110,111,115",
].join("\n");

function requireDir(value: string | null, label: string): string {
  if (!value) {
    console.error(`--${label} を指定してください。\n\n${USAGE}`);
    process.exit(2);
  }
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) {
    console.error(`--${label} のパスがありません: ${resolved}`);
    process.exit(2);
  }
  return resolved;
}

const PLUGIN_REPO = requireDir(arg("plugin"), "plugin");
const DICOM_DIR = requireDir(arg("dicom"), "dicom");
/** 既知病変のボクセル座標。指定が無ければ検出の当たり判定だけ飛ばす。 */
const TRUTH = ((): { x: number; y: number; z: number } | null => {
  const raw = arg("truth");
  if (!raw) return null;
  const [x, y, z] = raw.split(",").map((v) => Number.parseInt(v, 10));
  if (![x, y, z].every(Number.isFinite)) {
    console.error(`--truth の形式が不正です: ${raw}（x,y,z）`);
    process.exit(2);
  }
  return { x, y, z };
})();

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

/** ビルド済みプラグインを backend が走査する plugins フォルダへ置く。 */
function installPlugin(): void {
  const manifest = path.join(PLUGIN_REPO, "plugin.json");
  const bundle = path.join(PLUGIN_REPO, "dist", "ui.js");
  if (!fs.existsSync(bundle)) {
    throw new Error(`${bundle} がありません。プラグイン側で npm run build を実行してください。`);
  }
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(manifest, path.join(dst, "plugin.json"));
  fs.copyFileSync(bundle, path.join(dst, "ui.js"));
  const bytes = fs.statSync(bundle).size;
  console.log(`検証対象プラグインを配置: ${dst} (ui.js ${(bytes / 1024).toFixed(0)} KB)`);
}

function listDicomFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile());
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();

  const driver = new DesktopDriver();
  const recorder = createStepRecorder();
  await driver.start();
  let viewerPage: Page | null = null;

  try {
    await resetDb(driver.ports.http);
    const files = listDicomFiles(DICOM_DIR);
    console.log(`DICOM 取込: ${files.length} ファイル (${DICOM_DIR})`);
    const imported = await importPaths(driver.ports.http, files);
    console.log(`import: ${JSON.stringify(imported)}`);
    // 1 シリーズだけ取り込む前提。プラグインが読めた枚数と突き合わせる基準にする。
    const sliceCount = imported.imported;

    const mainPage = driver.page;
    mainPage.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
    });
    try {
      await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      console.log(`  MainScreen が出ないので reload して待ち直す（url=${mainPage.url()}）`);
      await mainPage.reload({ waitUntil: "domcontentloaded" });
      await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    }
    await openFirstSeriesInViewer(mainPage, recorder);
    viewerPage = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    viewerPage.on("console", (m) => {
      if (m.type() === "error") console.log(`  [viewer error] ${m.text()}`);
    });
    await viewerPage.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewerPage.waitForTimeout(2000);
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "1-viewer.png") });

    console.log("\n[1] Plug-ins メニューからプラグインを開く");
    await viewerPage.getByTestId("viewer2d-menu-plugins").click();
    const item = viewerPage.getByTestId(`plugin-item-${PLUGIN_ID}`);
    await item.waitFor({ state: "visible", timeout: 10_000 });
    check(true, "Plug-ins メニューにプラグインが出る");
    await item.click();
    await viewerPage.getByTestId("aneurysm-panel").waitFor({ state: "visible", timeout: 15_000 });
    check(true, "パネルが開く");
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "2-panel.png") });

    console.log("\n[2] 解析を実行（数分かかる）");
    await viewerPage.evaluate(() => {
      delete (window as unknown as { __aneurysmDetector?: unknown }).__aneurysmDetector;
    });
    const started = Date.now();
    await viewerPage.getByTestId("aneurysm-run").click();

    // 進捗を出しつつ完了を待つ
    let summary: DebugSummary | null = null;
    const deadline = started + 20 * 60_000;
    while (Date.now() < deadline) {
      summary = (await viewerPage.evaluate(
        () => (window as unknown as { __aneurysmDetector?: DebugSummary }).__aneurysmDetector ?? null,
      )) as DebugSummary | null;
      if (summary) break;
      const status = await viewerPage.getByTestId("aneurysm-status").textContent();
      console.log(`  … ${Math.round((Date.now() - started) / 1000)}s: ${status ?? ""}`);
      await viewerPage.waitForTimeout(10_000);
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    check(summary !== null, `解析が完走する（${elapsed}s）`);
    if (!summary) throw new Error("解析が時間内に終わらなかった");

    console.log(`\n解析結果: ${JSON.stringify({ ...summary, candidates: summary.candidates.length })}`);
    fs.writeFileSync(path.join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "3-result.png") });

    console.log("\n[3] host.getPixelData() でシリーズ全体を再構成できたか");
    // ここがこのスパイクの主目的。1 スライスずつ読んで積み直した結果が、
    // 取り込んだ実物（枚数）と一致することを見る。
    check(
      summary.dims[2] === sliceCount,
      `読めたスライス数が本体の枚数と一致（${sliceCount} 枚。1 枚ずつ ${sliceCount} 回読んで積み直している）`,
      { got: summary.dims[2], expected: sliceCount },
    );
    check(
      summary.dims[0] > 0 && summary.dims[1] > 0 && summary.dims[0] === summary.dims[1],
      "面内サイズが取れている",
      summary.dims,
    );
    check(
      summary.spacing.every((v) => v > 0 && Number.isFinite(v)),
      "spacing が 3 軸とも取れている（host の値をそのまま使えている）",
      summary.spacing,
    );
    check(
      summary.foregroundVoxels > 1000,
      "血管が抽出できている（前景ボクセルがある）",
      summary.foregroundVoxels,
    );
    check(summary.branchCount > 5, "血管の枝が構築される", summary.branchCount);
    check(summary.totalLengthMm > 100, "血管の総延長が 100mm 超", Math.round(summary.totalLengthMm));

    console.log("\n[4] 検出結果");
    // 取り込み時にスライス順が反転していても同じ病変と分かるよう、Z を反転した距離も見る。
    const truthDistance = (c: CandidateSummary): number => {
      if (!TRUTH) return Number.POSITIVE_INFINITY;
      const d = Math.hypot(c.peakPoint.x - TRUTH.x, c.peakPoint.y - TRUTH.y, c.peakPoint.z - TRUTH.z);
      const dFlipped = Math.hypot(
        c.peakPoint.x - TRUTH.x,
        c.peakPoint.y - TRUTH.y,
        c.peakPoint.z - (summary!.dims[2] - 1 - TRUTH.z),
      );
      return Math.min(d, dFlipped);
    };
    for (const c of summary.candidates) {
      const dist = truthDistance(c);
      console.log(
        `  #${c.id} score=${c.score.toFixed(1)} bulge=${c.maxBulgeRatio.toFixed(2)} ` +
          `wall=${c.maxWallDistanceMm.toFixed(2)}mm pos=(${c.peakPoint.x},${c.peakPoint.y},${c.peakPoint.z})` +
          (TRUTH ? ` truthDist=${dist.toFixed(1)}` : ""),
      );
    }
    check(summary.candidates.length > 0, "候補が 1 件以上出る", summary.candidates.length);
    check(
      summary.candidates.length <= 15,
      "候補が読影可能な件数に収まる（15 件以下）",
      summary.candidates.length,
    );

    const hitIndex = TRUTH
      ? summary.candidates.findIndex((c) => truthDistance(c) <= TRUTH_TOLERANCE)
      : -1;
    if (TRUTH) {
      check(hitIndex >= 0, `既知の病変が候補に出る（順位 ${hitIndex + 1} 位）`, hitIndex);
    } else {
      console.log("  （--truth 未指定のため検出の当たり判定は省略）");
    }

    check(summary.meshTriangles > 1000, "3D メッシュが生成される", summary.meshTriangles);

    console.log("\n[5] 2D ビューアへの重ね表示");
    // 重ねる前の画像を撮っておく（後で「本当に変わったか」を画素で比べる）。
    const hidePanel = () =>
      viewerPage!.evaluate(() => {
        const p = document.querySelector('[data-testid="aneurysm-panel"]') as HTMLElement | null;
        if (p) p.style.visibility = "hidden";
      });
    const showPanel = () =>
      viewerPage!.evaluate(() => {
        const p = document.querySelector('[data-testid="aneurysm-panel"]') as HTMLElement | null;
        if (p) p.style.visibility = "visible";
      });

    // 血管が写っているスライスへ送る（Z=1 は空気しか無く、重ねても何も見えない）。
    const targetSlice = summary.candidates[hitIndex >= 0 ? hitIndex : 0].peakPoint.z;
    const moved = await viewerPage.evaluate((z: number) => {
      const sliders = Array.from(
        document.querySelectorAll<HTMLInputElement>('input[type="range"]'),
      ).filter((s) => Number(s.max) >= 200);
      if (sliders.length === 0) return false;
      const slider = sliders[0];
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(slider, String(z));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }, targetSlice);
    check(moved, `候補のスライス（Z=${targetSlice + 1}）へ移動できる`);
    await viewerPage.waitForTimeout(1500);

    await hidePanel();
    await viewerPage.waitForTimeout(400);
    const before = await viewerPage.screenshot({ path: path.join(OUT_DIR, "4a-before-overlay.png") });
    await showPanel();

    await viewerPage.getByTestId("aneurysm-overlay").click();
    await viewerPage.waitForTimeout(1500);
    const overlayLabel = await viewerPage
      .getByText(/プラグイン:|Plugin:/)
      .first()
      .isVisible()
      .catch(() => false);
    check(overlayLabel, "本体が出所ラベル（プラグイン: …）を表示する");

    await hidePanel();
    await viewerPage.waitForTimeout(400);
    const after = await viewerPage.screenshot({ path: path.join(OUT_DIR, "4b-with-overlay.png") });
    await showPanel();
    // 「要素が出た」だけでなく**画が変わった**ことを確かめる（H4a の実機検証で
    // 空のキャンバスが乗ったまま合格しかけた前例があるため）。
    check(
      Buffer.compare(before, after) !== 0,
      "重ね表示で 2D の画が実際に変わる",
      { beforeBytes: before.length, afterBytes: after.length },
    );

    console.log("\n[6] 枝リストと CPR");
    await viewerPage.getByTestId("aneurysm-overlay").click(); // 重ね表示は戻す
    await viewerPage.getByText("枝 / CPR", { exact: false }).first().click();
    await viewerPage.waitForTimeout(300);
    const cprButton = viewerPage.getByRole("button", { name: "CPR を表示" }).first();
    await cprButton.waitFor({ state: "visible", timeout: 5000 });
    check(true, "枝リストが表示され CPR ボタンがある");
    await cprButton.click();
    await viewerPage.waitForTimeout(3000);
    // canvas の中身を読む（「要素がある」ではなく「像が描かれている」ことを見る）
    const cprStats = await viewerPage.evaluate(() => {
      const canvas = document.querySelector("canvas.gnad-cpr") as HTMLCanvasElement | null;
      if (!canvas || canvas.width === 0) return null;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let min = 255;
      let max = 0;
      let sum = 0;
      const n = img.length / 4;
      for (let i = 0; i < img.length; i += 4) {
        const g = img[i];
        if (g < min) min = g;
        if (g > max) max = g;
        sum += g;
      }
      return { width: canvas.width, height: canvas.height, min, max, mean: sum / n };
    });
    console.log(`  CPR: ${JSON.stringify(cprStats)}`);
    check(cprStats !== null, "CPR キャンバスが描かれる");
    check(
      (cprStats?.height ?? 0) > 50 && (cprStats?.width ?? 0) > 20,
      "CPR の大きさが枝の長さに見合う",
      cprStats,
    );
    check(
      (cprStats?.max ?? 0) - (cprStats?.min ?? 0) > 60,
      "CPR に濃淡がある（真っ黒・真っ白ではない）",
      cprStats,
    );
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "5-cpr.png") });

    console.log("\n[7] 観察評価の保存");
    await viewerPage.getByText("コブ候補", { exact: false }).first().click();
    await viewerPage.waitForTimeout(300);
    const typeSelect = viewerPage.locator("select.gnad-select").first();
    await typeSelect.selectOption("SACCULAR");
    await viewerPage.waitForTimeout(600);
    const stored = await viewerPage.evaluate(() => {
      const key = Object.keys(localStorage).find((k) =>
        k.startsWith("graphy-plugin-aneurysm-detector/review/"),
      );
      return key ? (localStorage.getItem(key) ?? null) : null;
    });
    check(stored !== null, "評価が localStorage に保存される");
    check(
      typeof stored === "string" && stored.includes("SACCULAR"),
      "変更した分類が保存内容に入る",
      stored?.slice(0, 200),
    );
    const suspected = await viewerPage.getByText(/動脈瘤の疑い|Suspected aneurysm/).first().isVisible();
    check(suspected, "判定バナーが「要疑い」を示す");
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "6-review.png") });

    console.log(`\n=== ${passed} 件合格 / ${failures.length} 件不合格 ===`);
    if (failures.length > 0) {
      for (const f of failures) console.log(`  - ${f}`);
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(e);
    if (viewerPage) {
      await viewerPage.screenshot({ path: path.join(OUT_DIR, "error.png") }).catch(() => undefined);
    }
    process.exitCode = 1;
  } finally {
    await driver.stop().catch(() => undefined);
  }
}

void main();

/*
 * UVS 骨組みプラグインの実機検証 — `fw/uvs-plugin-design.md` の段 2。
 *
 * 実行:  cd automator && npx tsx src/spike/uvsPluginCheck.ts
 *
 * <h3>何を確かめるのか（解析ではない）</h3>
 * **JAR 面を持つプラグインを本体で初めて作る**ので、まず**継ぎ目**を通す。そして
 * 「**この先の段で必要なものが、プラグインの JAR から実際に手が届くか**」を実機に答えさせる:
 *
 *   - RadiomicsJ / ImageJ / dcm4che が**親クラスローダから見えるか＋その版**（設計 §2.2 の前提）
 *   - **自分のフォルダのファイルを読めるか**（モデルの置き場が決まる）
 *   - **ffmpeg を解決できるか**（フレーム供給の土台）
 *   - **`/rendered` から MP4 を取れるか**（段 3 の経路）
 *
 * 🔴 **前提が外れていたら設計をやり直す。** だから解析を書く前にここを確定させる。
 *
 * 🚨 走らせる前に `.results/uvs-plugin` を消す（失敗した実行が前回の成果物を持ち帰る）。
 * 🚨 **JAR を変えたらアプリ再起動が要る**（ローダが id 単位でキャッシュされる）。
 *    automator は毎回プロセスを立て直すので問題にならないが、手元の dev-desktop では効かない。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs, findBlockingOverlay } from "../common/dismissDialogs.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "uvs-plugin");
const PLUGIN_ID = "uvs-skeleton";
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
/** 合否ではなく「事実を記録する」観測。設計の前提を確定させるためのもの。 */
function observe(label: string, detail: unknown): void {
  console.log(`  [観測] ${label} — ${JSON.stringify(detail)}`);
}

interface Probe {
  visible?: boolean;
  implementationVersion?: string | null;
  codeSource?: string | null;
  error?: string;
}
/** 段 6 の `op` 応答（`{ok, op, ...}`）。旧経路の巨大 Map とは別の形。 */
interface OpResult {
  ok?: boolean;
  op?: string;
  error?: string;
  sessionId?: string;
  width?: number;
  height?: number;
  numberOfFrames?: number;
  fps?: number;
  durationSec?: number | null;
  transferSyntaxUid?: string | null;
  transcodeRequired?: boolean;
  ffmpeg?: string;
  defaults?: {
    interval?: number;
    stride?: number;
    staticMeanAbsDiffThreshold?: number;
    staticMeanAbsDiffNote?: string;
    aviEquivalentMeanAbsDiff?: number;
    predictionThreshold?: number;
    extractor?: string;
    samplingPoints?: number;
    randomSeed?: number;
  };
  freedBytes?: number;
  existed?: boolean;
  // op:"prepare"
  from?: number;
  frames?: number;
  cpr?: number[];
  mad?: number[];
  sampleIndices?: number[];
  interval?: number;
  stride?: number;
  cachedFrames?: number;
  cacheBytes?: number;
  framesDecoded?: number;
  ffmpegRuns?: number;
  decodeMs?: number;
  // op:"checkCache"
  allMatch?: boolean;
  checked?: { index: number; cachedMd5: string | null; decodedMd5: string | null; same: boolean }[];
  // op:"predict"（チャンク）
  scores?: {
    sample: number;
    frameIndex: number;
    ok?: boolean;
    error?: string;
    probability?: number;
    padded?: boolean;
    elapsedMs?: number;
    rois?: {
      cluster: number;
      x: number;
      y: number;
      w: number;
      h: number;
      pixels: number;
      probability: number;
      padded?: boolean;
      paddedFeatures?: string[];
      features?: Record<string, number>;
    }[];
  }[];
  sampleFrom?: number;
  nextFrom?: number;
  total?: number;
  done?: boolean;
  anyPadded?: boolean;
  // op:"compose"
  heart?: number[];
  removedByPrediction?: number[];
  finalIndices?: number[];
  colorRemove?: number[];
  staticRemove?: number[];
  results?: Record<string, number | string>;
  interpolated?: number[];
}

/** `testdata/summary-composer-cases.json`（Java とフロントの共有ベクタ）。 */
interface ComposerVectors {
  cases: {
    name: string;
    frameCount: number;
    colorRemove: number[];
    staticRemove: number[];
    heart: number[] | null;
    userAdd: number[];
    userRemove: number[];
    expected: { heart: number[]; removedByPrediction: number[]; finalIndices: number[] };
  }[];
  interpolationCases: {
    name: string;
    known: number[];
    size: number;
    interval: number;
    expectedAt: Record<string, number>;
  }[];
  thresholdCases: {
    name: string;
    predScores: Record<string, number>;
    frameCount: number;
    interval: number;
    threshold: number;
    expectedHeartContains: number[];
    expectedHeartExcludes: number[];
  }[];
}

interface Payload {
  surface: string | null;
  hasRunBackend: boolean;
  targets:
    | { seriesUid: string; sopInstanceUid: string | null; modality: string | null; kind?: string | null }[]
    | null;
  sopInstanceUid?: string | null;
  apiBase?: string | null;
  backend: {
    ok?: boolean;
    op?: string;
    java?: string;
    radiomicsj?: Probe;
    imagej?: Probe;
    dcm4che?: Probe;
    pluginDir?: {
      resolved?: boolean;
      dir?: string;
      entries?: string[];
      referenceParamsBytes?: number;
      error?: string;
    };
    ffmpeg?: { resolved?: boolean; path?: string; version?: string; tried?: string[] };
    rendered?: { status?: number; contentType?: string; looksLikeMp4?: boolean; error?: string };
    roiResult?: {
      ok?: boolean;
      frameIndex?: number;
      rois?: { cluster: number; x: number; y: number; w: number; h: number }[];
      elapsedMs?: number;
      error?: string;
    };
    prediction?: {
      ok?: boolean;
      frameIndex?: number;
      radiomicsJVersion?: string;
      probability?: number;
      rois?: {
        cluster: number;
        x: number;
        y: number;
        w: number;
        h: number;
        pixels: number;
        probability: number;
        features?: Record<string, number>;
      }[];
      elapsedMs?: number;
      error?: string;
    };
    analysis?: {
      ok?: boolean;
      frames?: number;
      cpr?: number[];
      mad?: number[];
      samplingPoints?: number;
      elapsedMs?: number;
      error?: string;
    };
  } | null;
  error: string | null;
}

/** 検証用プラグインを backend の plugins フォルダへ置く（第三者の手置きと同じ形）。 */
function installPlugin(): void {
  const src = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    // ソースとビルド中間物は配らない（配布物と同じ形にする）。
    if (name === "src" || name === "out" || name === ".gitignore") continue;
    if (fs.statSync(from).isDirectory()) continue;
    fs.copyFileSync(from, path.join(dst, name));
  }
  console.log(`検証用プラグインを配置: ${dst}`);
  console.log(`  中身: ${fs.readdirSync(dst).join(", ")}`);
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const pluginDir = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
  const jar = path.join(pluginDir, `${PLUGIN_ID}.jar`);
  const buildHint = `  cd automator/plugins/${PLUGIN_ID} && bash tools/build-jar.sh`;
  if (!fs.existsSync(jar)) {
    throw new Error(`JAR がありません: ${jar}\n${buildHint}`);
  }
  // 🔴 **古い成果物で緑にしない。** ここは配布物と同じくフォルダをコピーするだけでビルドしない。
  //    src を直したのに焼き直しを忘れると、**直す前のコードで検査が通ってしまう**。
  //    JAR（Java 面）と ui.js（UI 面）の両方を見る。
  {
    const stale = (artifact: string, srcDir: string, ext: string, hint: string): void => {
      if (!fs.existsSync(srcDir)) return;
      const at = fs.statSync(artifact).mtimeMs;
      const newer: string[] = [];
      const walk = (dir: string): void => {
        for (const name of fs.readdirSync(dir)) {
          if (name === "node_modules") continue;
          const p = path.join(dir, name);
          if (fs.statSync(p).isDirectory()) walk(p);
          else if (name.endsWith(ext) && fs.statSync(p).mtimeMs > at) newer.push(p);
        }
      };
      walk(srcDir);
      if (newer.length > 0) {
        throw new Error(
          `${path.basename(artifact)} が古いです（${newer.length} 個の ${ext} が新しい）:\n` +
            newer.slice(0, 5).map((p) => `    ${path.relative(pluginDir, p)}`).join("\n") +
            `\n${hint}`,
        );
      }
    };
    stale(jar, path.join(pluginDir, "src", "com"), ".java", buildHint);
    stale(
      path.join(pluginDir, "ui.js"),
      path.join(pluginDir, "src", "ui"),
      ".ts",
      `  cd automator/plugins/${PLUGIN_ID} && npm run build`,
    );
  }
  if (!fs.existsSync(DEFAULT_DICOM)) {
    throw new Error(
      `サンプルがありません: ${DEFAULT_DICOM}\n` +
        `  python3 scripts/wrap-video-as-us-multiframe.py <AVI> ${DEFAULT_DICOM} --frames 600`,
    );
  }
  installPlugin();

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const mainPage = driver.page;
    mainPage.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [DEFAULT_DICOM]);
    check(imp.imported === 1, "[準備] サンプルを取り込めた", imp);

    const studies = (await (
      await fetch(`http://127.0.0.1:${driver.ports.http}/api/studies`)
    ).json()) as { studyInstanceUid: string }[];
    const studyUid = studies[0].studyInstanceUid;

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
      (url) => url.includes("2dviewer"),
    );
    await viewer.waitForTimeout(5_000);

    // ── 1. プラグインが一覧に出て、起動できる ──────────────────────
    const menu = viewer.getByTestId("viewer2d-menu-plugins");
    check(await menu.isVisible().catch(() => false), "[1] プラグインメニューが出る");
    await menu.click();
    await viewer.waitForTimeout(300);
    const item = viewer.getByTestId(`plugin-item-${PLUGIN_ID}`);
    check(
      await item.isVisible().catch(() => false),
      "[1] ★JAR 面つきプラグインが一覧に出る（entrypoint 宣言つきでも読める）",
    );
    await viewer.evaluate(() => {
      delete (window as unknown as { __uvsSkeleton?: unknown }).__uvsSkeleton;
    });
    await item.click();
    // backend 往復＋ffmpeg 起動を待つ。
    await viewer.waitForTimeout(8_000);

    const payload = (await viewer.evaluate(
      () => (window as unknown as { __uvsSkeleton?: Payload }).__uvsSkeleton ?? null,
    )) as Payload | null;
    fs.writeFileSync(path.join(OUT_DIR, "payload.json"), JSON.stringify(payload, null, 2));
    check(!!payload, "[1] プラグインが動いた（結果を書いた）");
    if (!payload) throw new Error("プラグインの結果を取得できませんでした");

    check(payload.hasRunBackend, "[1] host に runBackend が生えている（standalone）");
    check(payload.error == null, "[1] ★エラー無く走り切った", { error: payload.error });
    check(!!payload.backend?.ok, "[1] ★★JAR の run() が呼ばれ、戻りが JSON 化された", {
      java: payload.backend?.java,
    });

    const b = payload.backend ?? {};

    // ── 2. 🔴 設計 §2.2 の前提（親クラスローダから本体の依存が見えるか）──
    check(
      b.radiomicsj?.visible === true,
      "[2] ★★RadiomicsJ が親クラスローダから見える（設計の前提）",
      b.radiomicsj,
    );
    observe("[2] 🔴 RadiomicsJ の版（学習時は 2.1.16・本体は 2.4.0 のはず）", {
      implementationVersion: b.radiomicsj?.implementationVersion,
      codeSource: b.radiomicsj?.codeSource,
    });
    check(b.imagej?.visible === true, "[2] ★ImageJ が見える（RadiomicsJ の入力に要る）", b.imagej);
    check(b.dcm4che?.visible === true, "[2] dcm4che が見える", b.dcm4che);

    // ── 3. 自分のフォルダを読めるか（モデルの置き場）────────────────
    check(
      b.pluginDir?.resolved === true,
      "[3] ★自分のフォルダを解決できる",
      { dir: b.pluginDir?.dir, entries: b.pluginDir?.entries },
    );
    check(
      (b.pluginDir?.referenceParamsBytes ?? 0) > 100,
      "[3] ★★モデルのパラメータを自分のフォルダから読める（ui.js に埋めなくてよい）",
      { bytes: b.pluginDir?.referenceParamsBytes },
    );

    // ── 4. ffmpeg（フレーム供給の土台）──────────────────────────────
    // 🔑 ここは**観測**。解決できなければ「本体の口が要る」という段 2 の成果になる。
    observe("[4] ffmpeg の解決", b.ffmpeg);
    if (b.ffmpeg?.resolved !== true) {
      console.log(
        "  [注意] ffmpeg を素朴な探索では解決できなかった。" +
          "本体の解決順（fw/nondicom-ffmpeg.md）を JAR から呼ぶ口が要る。",
      );
    }

    // ── 5. /rendered から MP4（段 3 の経路）─────────────────────────
    observe("[5] /rendered の応答", b.rendered);

    // ── 6. 段 3: [A] 色判定 / [B] 静止判定を独立参照と突き合わせる ──
    // 🔑 **元アプリを動かさずに検証する。** `bench/uvs_frame_scores.py` は仕様（定数）から
    //    起こした**別実装**で、Java の `Random` を規格から再現している（一致は確認済み）。
    //    同じコードを写していないので「両方が同じように間違える」ことが起きにくい。
    const refPath = process.env.UVS_REF ?? "/tmp/uvs-ref.json";
    if (fs.existsSync(refPath)) {
      const ref = JSON.parse(fs.readFileSync(refPath, "utf8")) as {
        frames: number;
        cpr: number[];
        mad: number[];
      };
      await viewer.evaluate(
        (r) => {
          (window as unknown as { __uvsRequest?: unknown }).__uvsRequest = r;
          delete (window as unknown as { __uvsSkeleton?: unknown }).__uvsSkeleton;
        },
        { analyze: true, width: 720, height: 440, limit: ref.frames + 1 },
      );
      await viewer.getByTestId("viewer2d-menu-plugins").click();
      await viewer.waitForTimeout(300);
      await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
      await viewer.waitForTimeout(30_000);
      const p2 = (await viewer.evaluate(
        () => (window as unknown as { __uvsSkeleton?: Payload }).__uvsSkeleton ?? null,
      )) as Payload | null;
      fs.writeFileSync(path.join(OUT_DIR, "analysis.json"), JSON.stringify(p2?.backend?.analysis, null, 2));
      const a = p2?.backend?.analysis;
      check(a?.ok === true, "[6] ★解析が走った", { error: a?.error, elapsedMs: a?.elapsedMs });
      if (a?.ok) {
        check(
          a.frames === ref.frames,
          "[6] フレーム数が参照と一致",
          { got: a.frames, expected: ref.frames },
        );
        const maxDiff = (x: number[] | undefined, y: number[]) =>
          !x ? Number.POSITIVE_INFINITY
            : Math.max(...x.slice(0, Math.min(x.length, y.length)).map((v, i) => Math.abs(v - y[i])));
        const dCpr = maxDiff(a.cpr, ref.cpr);
        const dMad = maxDiff(a.mad, ref.mad);
        // 🔴 **どちらも厳密一致すべき**（整数演算と固定点列なので浮動小数の揺れも小さい）。
        check(dCpr < 1e-9, "[6] ★★CPR 列が独立参照と一致", { maxDiff: dCpr, n: a.cpr?.length });
        check(dMad < 1e-9, "[6] ★★MAD 列が独立参照と一致", { maxDiff: dMad, n: a.mad?.length });
        observe("[6] 先頭 3 件（Java / 参照）", {
          cprJava: a.cpr?.slice(0, 3),
          cprRef: ref.cpr.slice(0, 3),
          madJava: a.mad?.slice(0, 3),
          madRef: ref.mad.slice(0, 3),
        });
      }
    } else {
      console.log(`  [注意] 参照値が無いので段 3 の検査を飛ばした: ${refPath}`);
    }

    // ── 7. 段 4: 候補 ROI を移植元の実装と突き合わせる ──────────────
    // 🔑 **相手は移植元そのもの**（`/tmp/uvs-ref-build/RefRoi`）。段 3 と違って
    //    独立実装ではない——Farnebäck を書き直す独立性より、**元と一致すること**が
    //    移植の要件だから。ここで見ているのは実質「**配線が正しいか**」
    //    （フレームを正しい番号・正しい向きで渡せているか）。
    const roiRefPath = process.env.UVS_ROI_REF ?? "/tmp/uvs-roi-ref.json";
    if (fs.existsSync(roiRefPath)) {
      const roiRef = JSON.parse(fs.readFileSync(roiRefPath, "utf8")) as {
        stride: number;
        frames: { frameIndex: number; rois: { x: number; y: number; w: number; h: number }[] }[];
      };
      for (const want of roiRef.frames) {
        await viewer.evaluate(
          (r) => {
            (window as unknown as { __uvsRequest?: unknown }).__uvsRequest = r;
            delete (window as unknown as { __uvsSkeleton?: unknown }).__uvsSkeleton;
          },
          { roi: true, width: 720, height: 440, stride: roiRef.stride, frameIndex: want.frameIndex },
        );
        await viewer.getByTestId("viewer2d-menu-plugins").click();
        await viewer.waitForTimeout(300);
        await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
        await viewer.waitForTimeout(20_000);
        const p3 = (await viewer.evaluate(
          () => (window as unknown as { __uvsSkeleton?: Payload }).__uvsSkeleton ?? null,
        )) as Payload | null;
        const got = p3?.backend?.roiResult;
        const g = got?.rois?.[0];
        const e = want.rois[0];
        check(
          got?.ok === true && !!g,
          `[7] フレーム ${want.frameIndex}: ROI が返った`,
          { error: got?.error, elapsedMs: got?.elapsedMs },
        );
        if (g) {
          check(
            g.x === e.x && g.y === e.y && g.w === e.w && g.h === e.h,
            `[7] ★★フレーム ${want.frameIndex}: ROI が移植元と一致`,
            { got: [g.x, g.y, g.w, g.h], expected: [e.x, e.y, e.w, e.h] },
          );
        }
      }
    } else {
      console.log(`  [注意] ROI の参照値が無いので段 4 の検査を飛ばした: ${roiRefPath}`);
    }

    // ── 8. 段 5: 15 特徴 ＋ LR 推論を突き合わせる ────────────────────
    // 🔴 **相手は「RadiomicsJ 2.4.0 で走らせた同じコード」**（`RefFeat`）。
    //    学習は 2.1.16 だが、版差は §8.8 で別途 2 版を突き合わせて閉じてある
    //    （15 特徴すべて完全一致）。ここで見ているのは**プラグイン内で同じ値が出るか**＝
    //    モデルの読み込み・特徴の順序・シグモイドの向きが正しいか。
    // ⚠️ **確率は「もっともらしい数」が出てしまう**ので、確率だけでなく
    //    **15 特徴を 1 つずつ**突き合わせる（向きの取り違えは確率だけ見ると気づけない）。
    const predRefPath = process.env.UVS_PREDICT_REF ?? "/tmp/uvs-predict-ref.json";
    if (fs.existsSync(predRefPath)) {
      const predRef = JSON.parse(fs.readFileSync(predRefPath, "utf8")) as Record<
        string,
        { bounds: number[]; pixels: number; probability: number; features: Record<string, number> }
      >;
      for (const [key, want] of Object.entries(predRef)) {
        const frameIndex = Number(key);
        await viewer.evaluate(
          (r) => {
            (window as unknown as { __uvsRequest?: unknown }).__uvsRequest = r;
            delete (window as unknown as { __uvsSkeleton?: unknown }).__uvsSkeleton;
          },
          { predict: true, width: 720, height: 440, stride: 6, frameIndex },
        );
        await viewer.getByTestId("viewer2d-menu-plugins").click();
        await viewer.waitForTimeout(300);
        await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
        await viewer.waitForTimeout(30_000);
        const p4 = (await viewer.evaluate(
          () => (window as unknown as { __uvsSkeleton?: Payload }).__uvsSkeleton ?? null,
        )) as Payload | null;
        const got = p4?.backend?.prediction;
        const roi = got?.rois?.[0];
        check(
          got?.ok === true && !!roi,
          `[8] フレーム ${frameIndex}: 推論が返った`,
          { error: got?.error, elapsedMs: got?.elapsedMs, radiomicsJ: got?.radiomicsJVersion },
        );
        if (!roi) continue;

        check(
          roi.pixels === want.pixels,
          `[8] フレーム ${frameIndex}: 切り出した画素数が一致`,
          { got: roi.pixels, expected: want.pixels },
        );

        // 15 特徴を 1 つずつ。相対 1e-9 まで（double の演算順序ぶんだけ許す）。
        let worstName = "";
        let worstRel = 0;
        for (const [name, expected] of Object.entries(want.features)) {
          const actual = roi.features?.[name];
          const rel =
            typeof actual === "number"
              ? Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-12)
              : Number.POSITIVE_INFINITY;
          if (rel > worstRel) {
            worstRel = rel;
            worstName = name;
          }
        }
        check(
          worstRel <= 1e-9,
          `[8] ★★フレーム ${frameIndex}: 15 特徴すべてが参照と一致`,
          {
            worstFeature: worstName,
            worstRel,
            n: Object.keys(want.features).length,
          },
        );

        const dp = Math.abs((roi.probability ?? NaN) - want.probability);
        check(
          dp <= 1e-9,
          `[8] ★★フレーム ${frameIndex}: 確率が参照と一致（シグモイドの向きを含む）`,
          { got: roi.probability, expected: want.probability, diff: dp },
        );
      }
    } else {
      console.log(`  [注意] 推論の参照値が無いので段 5 の検査を飛ばした: ${predRefPath}`);
    }

    // ── 9. 段 6: op 方式（セッション）────────────────────────────────
    // 🔑 旧経路（analyze/roi/predict）は**そのまま**動き続けることが上の 1〜8 で示されている。
    //    ここで見るのは「op を足したことで、状態を持つ呼び方ができるようになったか」。
    {
      /**
       * op を 1 回投げて、結果が書かれるまで**待つ**。
       *
       * ⚠️ 固定待ちにしない。予測は 1 サンプル 2〜3 秒だが走査は 1 秒で終わる——固定にすると
       * 遅いほうに合わせることになり、実機検証が何分も伸びる（実際、Electron ＋ backend を
       * 抱えたまま待ち続けてメモリ不足で落とされた）。**書かれた瞬間に進む。**
       */
      const runOp = async (request: Record<string, unknown>, maxWaitMs = 30_000): Promise<OpResult | null> => {
        await viewer.evaluate((r) => {
          (window as unknown as { __uvsRequest?: unknown }).__uvsRequest = r;
          delete (window as unknown as { __uvsSkeleton?: unknown }).__uvsSkeleton;
        }, request);
        await viewer.getByTestId("viewer2d-menu-plugins").click();
        await viewer.waitForTimeout(300);
        await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
        const deadline = Date.now() + maxWaitMs;
        while (Date.now() < deadline) {
          const p = (await viewer.evaluate(
            () => (window as unknown as { __uvsSkeleton?: Payload }).__uvsSkeleton ?? null,
          )) as Payload | null;
          if (p) return (p.backend as OpResult | undefined) ?? null;
          await viewer.waitForTimeout(250);
        }
        return null;
      };

      const info = await runOp({ op: "info" });
      fs.writeFileSync(path.join(OUT_DIR, "info.json"), JSON.stringify(info, null, 2));
      check(info?.ok === true, "[9] ★op:info が応えた", { error: info?.error });
      if (info?.ok) {
        // 🔑 **寸法とフレーム数は JAR が /video-metadata から取る**。ui.js が渡す形はやめた
        //    （渡し忘れると「width/height が無い」で落ちるだけだった）。
        check(
          (info.width ?? 0) > 0 && (info.height ?? 0) > 0 && (info.numberOfFrames ?? 0) > 0,
          "[9] ★★動画の諸元を JAR 自身が取れた（ui.js からの手渡しが要らない）",
          { width: info.width, height: info.height, frames: info.numberOfFrames, fps: info.fps },
        );
        // 🚨 設計 §7: AVI の 0.5 をそのまま出すと、H.264 では静止判定が 10.4 倍出る。
        check(
          info.defaults?.staticMeanAbsDiffThreshold === 0.19,
          "[9] 🚨静止判定の既定が 0.19（圧縮動画向け・0.5 ではない）",
          info.defaults,
        );
        check(
          (info.defaults?.interval ?? 0) > 0 && (info.defaults?.stride ?? 0) > 0,
          "[9] 間引き間隔と差分距離が fps から導かれている",
          { interval: info.defaults?.interval, stride: info.defaults?.stride },
        );
        observe("[9] 動画の出自（画面にそのまま出す値）", {
          transferSyntaxUid: info.transferSyntaxUid,
          transcodeRequired: info.transcodeRequired,
          ffmpeg: info.ffmpeg,
        });

        const released = await runOp({ op: "release", sessionId: info.sessionId }, 3_000);
        check(released?.ok === true && released?.existed === true,
          "[9] ★op:release でセッションを閉じられる", released);
        const again = await runOp({ op: "release", sessionId: info.sessionId }, 3_000);
        // 🔑 二重解放は**成功**にする（窓を閉じたときと明示解放が重なるのはふつうに起きる）。
        check(again?.ok === true && again?.existed === false,
          "[9] 既に無いセッションの release は赤くしない", again);
      }
      // ── 段 6-2: prepare（1 パス走査＋フレームキャッシュ）────────────
      // 🔴 **ここが段 6 の要**。キャッシュしたフレームが復号結果と 1 バイトでも違うと、
      //    ROI が静かにずれ「確率だけが違う」という気づきにくい壊れ方になる。
      if (fs.existsSync(refPath)) {
        const ref = JSON.parse(fs.readFileSync(refPath, "utf8")) as { frames: number; cpr: number[]; mad: number[] };
        const info2 = await runOp({ op: "info" });
        const prep = await runOp(
          { op: "prepare", sessionId: info2?.sessionId, from: 0, count: ref.frames },
          60_000,
        );
        fs.writeFileSync(path.join(OUT_DIR, "prepare.json"), JSON.stringify(
          { ...prep, cpr: prep?.cpr?.slice(0, 5), mad: prep?.mad?.slice(0, 5) }, null, 2));
        check(prep?.ok === true, "[9] ★op:prepare が走った", { error: prep?.error, decodeMs: prep?.decodeMs });
        if (prep?.ok) {
          const maxDiff = (x: number[] | undefined, y: number[]) =>
            !x ? Number.POSITIVE_INFINITY
              : Math.max(...x.slice(0, Math.min(x.length, y.length)).map((v, i) => Math.abs(v - y[i])));
          // 🔑 相手は段 3 と**同じ独立参照**（bench/uvs_frame_scores.py）。走査の作りを
          //    1 パスへ変えても、出る数字は 1 ビットも変わっていないこと。
          check(prep.frames === ref.frames, "[9] prepare のフレーム数が参照と一致",
            { got: prep.frames, expected: ref.frames });
          check(maxDiff(prep.cpr, ref.cpr) < 1e-12, "[9] ★★prepare の CPR 列が独立参照と一致",
            { maxDiff: maxDiff(prep.cpr, ref.cpr), n: prep.cpr?.length });
          check(maxDiff(prep.mad, ref.mad) < 1e-12, "[9] ★★prepare の MAD 列が独立参照と一致",
            { maxDiff: maxDiff(prep.mad, ref.mad), n: prep.mad?.length });
          check(prep.ffmpegRuns === 1, "[9] 🔴復号は 1 回だけ（readPair の総なめに戻っていない）",
            { ffmpegRuns: prep.ffmpegRuns, framesDecoded: prep.framesDecoded });
          check(
            (prep.sampleIndices?.length ?? 0) > 0 &&
              (prep.sampleIndices ?? []).every((i) => i % (prep.interval ?? 1) === 0),
            "[9] 予測の格子が動画全体で固定（index % interval === 0）",
            { samples: prep.sampleIndices, interval: prep.interval },
          );
          check((prep.cachedFrames ?? 0) > 0, "[9] 予測用フレームがキャッシュされた",
            { cachedFrames: prep.cachedFrames, cacheBytes: prep.cacheBytes });

          const cc = await runOp({ op: "checkCache", sessionId: info2?.sessionId }, 30_000);
          fs.writeFileSync(path.join(OUT_DIR, "check-cache.json"), JSON.stringify(cc, null, 2));
          // 🚨 相手は readPair ＝ 段 4 / 段 5 が実際に使って移植元と完全一致した経路。
          check(cc?.allMatch === true,
            "[9] ★★★キャッシュしたフレームが復号結果と byte 単位で一致（md5）", cc?.checked);
        }
        await runOp({ op: "release", sessionId: info2?.sessionId }, 3_000);
      }

      // ── 段 6-4: 合成規則を共有ベクタで固定する ──────────────────────
      // 🔑 このベクタは**フロント実装（段 6-6）と共有する**。Java 側がここで緑になっていて
      //    初めて「フロントの写しが正しいか」を突き合わせられる。
      {
        const vectors = JSON.parse(
          fs.readFileSync(
            path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID, "testdata", "summary-composer-cases.json"),
            "utf8",
          ),
        ) as ComposerVectors;
        const eq = (a: number[] | undefined, b: number[]) =>
          !!a && a.length === b.length && a.every((v, i) => v === b[i]);

        let composeFails = 0;
        for (const c of vectors.cases) {
          const got = await runOp({
            op: "compose",
            frameCount: c.frameCount,
            colorRemove: c.colorRemove,
            staticRemove: c.staticRemove,
            heart: c.heart,
            userAdd: c.userAdd,
            userRemove: c.userRemove,
          }, 10_000);
          const ok = got?.ok === true
            && eq(got.heart, c.expected.heart)
            && eq(got.removedByPrediction, c.expected.removedByPrediction)
            && eq(got.finalIndices, c.expected.finalIndices);
          if (!ok) {
            composeFails++;
            observe(`[9] compose 不一致: ${c.name}`, { got: got?.finalIndices, expected: c.expected.finalIndices });
          }
        }
        check(composeFails === 0, "[9] ★★op:compose が共有ベクタ 7 件すべてに一致",
          { cases: vectors.cases.length, fails: composeFails });

        // 🔴 しきい値ハンドルのドラッグが触るのは**補間とクランプ**。ここを飛ばさない。
        let thFails = 0;
        for (const c of vectors.thresholdCases) {
          const got = await runOp({
            op: "compose",
            frameCount: c.frameCount,
            colorRemove: [],
            staticRemove: [],
            predScores: c.predScores,
            interval: c.interval,
            threshold: c.threshold,
          }, 10_000);
          const heart = got?.heart ?? [];
          const okIn = c.expectedHeartContains.every((i) => heart.includes(i));
          const okOut = c.expectedHeartExcludes.every((i) => !heart.includes(i));
          if (got?.ok !== true || !okIn || !okOut) {
            thFails++;
            observe(`[9] しきい値の適用が不一致: ${c.name}`, { heart, want: c.expectedHeartContains });
          }
        }
        check(thFails === 0, "[9] ★★確率しきい値の適用（補間＋クランプ）が共有ベクタに一致",
          { cases: vectors.thresholdCases.length, fails: thFails });

        // 除外の内訳は**重なる**。足し合わせて総数にならないことを実データで示す。
        const overlap = await runOp({
          op: "compose",
          frameCount: 10,
          colorRemove: [2, 3],
          staticRemove: [3, 4],
          heart: [1, 2, 3, 4, 5],
          userAdd: [],
          userRemove: [],
        }, 10_000);
        const res = overlap?.results ?? {};
        check(
          overlap?.ok === true
            && Number(res.colorRemoved) + Number(res.staticRemoved) + Number(res.probaRemoved)
              !== Number(res.totalRemoved),
          "[9] 🔴除外の内訳は重なる（足し合わせても総数にならない＝画面にそう書く）",
          res,
        );
      }

      // ── 段 6-3: チャンク予測が、段 5 の参照と 1 ビットも違わないこと ──
      // 🔑 **間引きを 10 にすると、格子はちょうど参照のフレーム（0/10/20/30）に重なる。**
      //    経路は変わった（readPair での都度復号 → キャッシュからの読み出し）が、
      //    出る数字が同じであることを、段 5 と**同じ参照値**で確かめる。
      if (fs.existsSync(predRefPath)) {
        const predRef = JSON.parse(fs.readFileSync(predRefPath, "utf8")) as Record<
          string,
          { bounds: number[]; pixels: number; probability: number; features: Record<string, number> }
        >;
        const wanted = Object.keys(predRef).map(Number).sort((a, b) => a - b);
        const info4 = await runOp({ op: "info" });
        const prep2 = await runOp(
          { op: "prepare", sessionId: info4?.sessionId, from: 0, count: wanted[wanted.length - 1] + 1, interval: 10 },
          60_000,
        );
        check(prep2?.ok === true, "[9] 予測用の走査が通った（間引き 10）", { error: prep2?.error });

        const chunk = await runOp(
          {
            op: "predict",
            sessionId: info4?.sessionId,
            sampleFrom: 0,
            sampleCount: wanted.length,
            includeFeatures: true,
          },
          120_000,
        );
        fs.writeFileSync(path.join(OUT_DIR, "predict-chunk.json"), JSON.stringify(chunk, null, 2));
        check(chunk?.ok === true, "[9] ★op:predict（チャンク）が走った", { error: chunk?.error });
        if (chunk?.ok) {
          // 🔑 チャンクは「次はここから」を返す＝フロントが進捗と中止を持てる。
          check(
            chunk.nextFrom === wanted.length && typeof chunk.total === "number",
            "[9] 次のチャンクの開始位置と総数を返す（進捗はフロントが持てる）",
            { nextFrom: chunk.nextFrom, total: chunk.total, done: chunk.done },
          );
          for (const frameIndex of wanted) {
            const want = predRef[String(frameIndex)];
            const row = chunk.scores?.find((x) => x.frameIndex === frameIndex);
            const roi = row?.rois?.[0];
            check(!!roi, `[9] フレーム ${frameIndex}: キャッシュ経由で推論できた`, {
              error: row?.error, elapsedMs: row?.elapsedMs,
            });
            if (!roi) continue;
            check(roi.pixels === want.pixels, `[9] フレーム ${frameIndex}: 画素数が段 5 と一致`,
              { got: roi.pixels, expected: want.pixels });
            let worstName = "";
            let worstRel = 0;
            for (const [name, expected] of Object.entries(want.features)) {
              const actual = roi.features?.[name];
              const rel = typeof actual === "number"
                ? Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-12)
                : Number.POSITIVE_INFINITY;
              if (rel > worstRel) { worstRel = rel; worstName = name; }
            }
            check(worstRel <= 1e-9,
              `[9] ★★★フレーム ${frameIndex}: キャッシュ経由でも 15 特徴が段 5 と一致`,
              { worstFeature: worstName, worstRel });
            check(Math.abs((roi.probability ?? NaN) - want.probability) <= 1e-9,
              `[9] ★★★フレーム ${frameIndex}: キャッシュ経由でも確率が段 5 と一致`,
              { got: roi.probability, expected: want.probability });
          }
          // ⚠️ padding は「潰す」のではなく**観測する**（未検証の経路・§8.10）。
          observe("[9] ⚠️ padding が通ったか（未検証の経路の観測窓）", {
            anyPadded: chunk.anyPadded,
            paddedFrames: chunk.scores?.filter((x) => x.padded).map((x) => x.frameIndex),
          });
        }
        await runOp({ op: "release", sessionId: info4?.sessionId }, 5_000);
      }

      // ── 段 6-2: 動画まるごと 1 本を走らせる（実際の使い方）────────────
      // 📏 ここで得た「1 パスの所要時間」と「キャッシュの容量」が、画面の見積もりの根拠になる。
      {
        const info3 = await runOp({ op: "info" });
        const whole = await runOp({ op: "prepare", sessionId: info3?.sessionId }, 120_000);
        check(whole?.ok === true, "[9] ★動画まるごとの走査が通った", { error: whole?.error });
        if (whole?.ok) {
          const frames = info3?.numberOfFrames ?? 0;
          check(
            (whole.frames ?? 0) >= frames - 1,
            "[9] 末尾まで走査した（区間指定なし＝全部）",
            { scored: whole.frames, videoFrames: frames },
          );
          const expectedSamples = Math.floor((frames - 1) / (whole.interval ?? 1)) + 1;
          check(
            whole.sampleIndices?.length === expectedSamples,
            "[9] 予測サンプル数が間引き間隔から予想どおり",
            { got: whole.sampleIndices?.length, expected: expectedSamples, interval: whole.interval },
          );
          observe("[9] 📏 1 パスの実測（画面の見積もりの根拠）", {
            framesDecoded: whole.framesDecoded,
            decodeMs: whole.decodeMs,
            cachedFrames: whole.cachedFrames,
            cacheMB: Math.round((whole.cacheBytes ?? 0) / 1024 / 1024),
          });
          const freed = await runOp({ op: "release", sessionId: info3?.sessionId }, 5_000);
          // 🔴 閉じたら一時ファイルは消えていること（数百 MB を置きっぱなしにしない）。
          check(
            (freed?.freedBytes ?? 0) >= (whole.cacheBytes ?? 0),
            "[9] ★release でキャッシュが実際に解放される",
            { freedBytes: freed?.freedBytes, cacheBytes: whole.cacheBytes },
          );
        }
      }

      // ── 段 6-7: 🚨 **画面を実際に押す** ────────────────────────────
      // v0.2.7 の反省（CLAUDE.md ルール 9）: 「要素があること」は「操作が効くこと」の証拠に
      // ならない。ここは押す・ドラッグする・入力する検査だけを書く。
      if (fs.existsSync(refPath)) {
        const ref = JSON.parse(fs.readFileSync(refPath, "utf8")) as { frames: number; cpr: number[]; mad: number[] };
        interface UvsDebug {
          scan: { from: number; frames: number; cpr: number[]; mad: number[]; sampleIndices: number[] } | null;
          predict: { done: number; total: number; anyPadded: boolean } | null;
          composed: {
            finalIndices: number[]; heart: number[]; frameCount: number; interval: number;
            colorRemove: number[]; staticRemove: number[]; predScores: Record<string, number>;
            results: Record<string, number>;
          } | null;
          progress: number;
          backendCalls: number;
          threshold: number;
          madThreshold: number;
          info: { numberOfFrames: number; fps: number; transferSyntaxUid: string | null } | null;
          error: string | null;
        }
        const readDebug = async (): Promise<UvsDebug | null> =>
          (await viewer.evaluate(
            () => (window as unknown as { __uvsDebug?: UvsDebug }).__uvsDebug ?? null,
          )) as UvsDebug | null;
        const waitFor = async (
          pred: (d: UvsDebug | null) => boolean, maxMs: number, onTick?: (d: UvsDebug | null) => void,
        ): Promise<UvsDebug | null> => {
          const deadline = Date.now() + maxMs;
          for (;;) {
            const d = await readDebug();
            onTick?.(d);
            if (pred(d)) return d;
            if (Date.now() > deadline) return d;
            await viewer.waitForTimeout(250);
          }
        };

        // 🔑 **指示を消してから開く**＝利用者と同じ経路（画面が出る）。
        await viewer.evaluate(() => {
          delete (window as unknown as { __uvsRequest?: unknown }).__uvsRequest;
          delete (window as unknown as { __uvsDebug?: unknown }).__uvsDebug;
        });
        await viewer.getByTestId("viewer2d-menu-plugins").click();
        await viewer.waitForTimeout(300);
        await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();

        // ⚠️ 段 1 の最初のクリック（指示なし）でも画面は開くので、**この節で開いた最後の 1 枚**に
        //    絞る。絞らないと strict mode で「2 つ見つかった」と落ちる。
        const panel = viewer.getByTestId("uvs-panel").last();
        const ui = (testId: string) => panel.getByTestId(testId);
        await panel.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
        check(await panel.isVisible(), "[9] ★画面が開く（利用者の経路）");

        const opened = await waitFor((d) => !!d?.info, 20_000);
        check(!!opened?.info, "[9] 動画の諸元が画面に載る", opened?.info ?? {});
        // 🚨 設計 §7: 0.19 と「圧縮動画向け」の注記が読めること。
        const madValue = await ui("uvs-mad-input").inputValue();
        check(Number(madValue) === 0.19, "[9] 🚨静止しきい値の初期値が 0.19（画面）", { madValue });
        const settingsText = await panel.innerText();
        check(
          settingsText.includes("圧縮動画") || settingsText.includes("compressed"),
          "[9] 「圧縮動画向け」の注記が画面にある（数字だけ見せない）",
        );
        check(
          settingsText.includes("1.2.840.10008.1.2.4.102"),
          "[9] 動画の出自（転送構文）を画面に出している",
        );

        // ── 走査を押す（独立参照と一致するところまで画面経由で確かめる）──
        await ui("uvs-range-count").fill(String(ref.frames));
        await ui("uvs-range-count").dispatchEvent("change");
        await ui("uvs-interval-input").fill("10");
        await ui("uvs-interval-input").dispatchEvent("change");
        await ui("uvs-run-both").click();
        const scanned = await waitFor((d) => !!d?.scan, 60_000);
        const maxDiff = (x: number[] | undefined, y: number[]) =>
          !x ? Number.POSITIVE_INFINITY
            : Math.max(...x.slice(0, Math.min(x.length, y.length)).map((v, i) => Math.abs(v - y[i])));
        check(
          !!scanned?.scan && maxDiff(scanned.scan.cpr, ref.cpr) < 1e-12
            && maxDiff(scanned.scan.mad, ref.mad) < 1e-12,
          "[9] ★★画面から走らせた CPR / MAD が独立参照と一致",
          { frames: scanned?.scan?.frames, cpr: maxDiff(scanned?.scan?.cpr, ref.cpr) },
        );

        // 🚨 このサンプルは**既定のカラー比率で全フレームがカラー扱いになる**（実測）。
        //    空の要約を涼しい顔で出さず、理由が読める警告が出ていること。
        const warning = await ui("uvs-warning").innerText();
        check(
          warning.includes("カラー判定でほぼ全フレーム") || warning.includes("Color detection removed"),
          "[9] 🚨ほぼ全フレームが落ちたときは理由を書いた警告を出す（黙って空を出さない）",
          { warning: warning.slice(0, 80) },
        );

        // ── 予測を押す（進捗の中間値を必ず 1 回は観測する）──
        let sawIntermediate = false;
        await ui("uvs-run-predict").click();
        const predicted = await waitFor(
          (d) => !!d?.predict && d.predict.done >= d.predict.total,
          180_000,
          (d) => {
            const p = d?.progress ?? 0;
            if (p > 0 && p < 1) sawIntermediate = true;
          },
        );
        check(
          !!predicted?.predict && predicted.predict.done === predicted.predict.total,
          "[9] ★予測が最後まで進んだ（画面から）",
          predicted?.predict ?? {},
        );
        // 🔴 終了値だけ見ない。**途中の進捗が出ている**＝分割が効いている証拠。
        check(sawIntermediate, "[9] ★★進捗の中間値を観測した（押して 11 分無反応にならない）");
        observe("[9] ⚠️ padding が通ったか（画面経由）", { anyPadded: predicted?.predict?.anyPadded });

        // ── しきい値ハンドルを**ポインタでドラッグ**する ──
        const before = await readDebug();
        const callsBefore = before?.backendCalls ?? 0;
        const finalBefore = (before?.composed?.finalIndices ?? []).length;
        const handle = ui("uvs-threshold-handle");
        const box = await handle.boundingBox();
        check(!!box, "[9] しきい値ハンドルが掴める位置にある");
        if (box) {
          const chartBox = await ui("uvs-chart").boundingBox();
          await viewer.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await viewer.mouse.down();
          // 下へドラッグ＝しきい値を下げる（採用が増える向き）。
          await viewer.mouse.move(
            box.x + box.width / 2,
            (chartBox?.y ?? box.y) + (chartBox?.height ?? 100) - 4,
            { steps: 8 },
          );
          await viewer.mouse.up();
        }
        const after = await waitFor((d) => (d?.threshold ?? 1) < (before?.threshold ?? 1), 5_000);
        check(
          (after?.threshold ?? 1) < (before?.threshold ?? 1),
          "[9] ★★★ハンドルをドラッグするとしきい値が変わる（JS 代入ではなく実操作）",
          { before: before?.threshold, after: after?.threshold },
        );
        check(
          (after?.composed?.finalIndices.length ?? 0) >= finalBefore,
          "[9] しきい値を下げると採用フレームは減らない",
          { before: finalBefore, after: after?.composed?.finalIndices.length },
        );
        // 🔴 **往復していないこと**を数字で示す（「速い気がする」で済ませない）。
        check(
          (after?.backendCalls ?? -1) === callsBefore,
          "[9] ★★★ドラッグ中に backend への往復が 1 回も増えない（フロントで再合成）",
          { before: callsBefore, after: after?.backendCalls },
        );

        // ── 手動の追加が最優先であること ──
        await ui("uvs-manual-input").fill("3-5");
        await ui("uvs-manual-input").dispatchEvent("change");
        const manual = await waitFor((d) => (d?.composed?.finalIndices ?? []).includes(3), 5_000);
        check(
          [3, 4, 5].every((i) => (manual?.composed?.finalIndices ?? []).includes(i)),
          "[9] ★手動で追加したフレームはあらゆる除外に勝つ",
          { has3: manual?.composed?.finalIndices.includes(3) },
        );

        // ── 🔴 オラクル照合: 画面の答え vs Java の正本（同じ入力）──
        const c = manual?.composed;
        if (c) {
          const java = await runOp({
            op: "compose",
            frameCount: c.frameCount,
            colorRemove: c.colorRemove,
            staticRemove: c.staticRemove,
            predScores: c.predScores,
            interval: c.interval,
            threshold: manual?.threshold,
            userAdd: [3, 4, 5],
          }, 15_000);
          const same = (a: number[] | undefined, b: number[]) =>
            !!a && a.length === b.length && a.every((v, i) => v === b[i]);
          check(
            java?.ok === true && same(java.finalIndices, c.finalIndices) && same(java.heart, c.heart),
            "[9] ★★★画面の合成が Java の正本と実データで完全一致（§9 の最終インデックスの一致）",
            {
              frameCount: c.frameCount,
              front: c.finalIndices.length,
              java: java?.finalIndices?.length,
              frontHeart: c.heart.length,
              javaHeart: java?.heart?.length,
            },
          );
        }

        // ── レポートへ差し込む ──
        await viewer.evaluate(() => {
          delete (window as unknown as { __uvsRequest?: unknown }).__uvsRequest;
        });
        await ui("uvs-publish-report").click();
        await viewer.waitForTimeout(1_000);
        const publishStatus = await ui("uvs-publish-status").innerText();
        // 🚨 **「登録」で部分一致させない。** 失敗文言「登録できませんでした」も通ってしまい、
        //    実際に一度これで緑になった（H39 が動画タイルで塞がっていたのに気付けなかった）。
        check(
          publishStatus.includes("登録しました") || publishStatus.toLowerCase().includes("registered"),
          "[9] ★レポートの候補に登録できた（H39・動画タイル）",
          { publishStatus },
        );
      }

      const unknown = await runOp({ op: "no-such-op" }, 3_000);
      check(
        unknown?.ok === false && (unknown?.error ?? "").includes("未知の op"),
        "[9] 知らない op は理由を返す（黙って空を返さない）",
        unknown,
      );
    }

    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer.png") }).catch(() => {});
  } finally {
    await driver.stop().catch(() => {});
  }

  console.log(`\n===== UVS プラグイン 実機検証（段 2〜6）=====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

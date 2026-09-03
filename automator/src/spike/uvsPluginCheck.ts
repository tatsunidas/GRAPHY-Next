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
interface Payload {
  surface: string | null;
  hasRunBackend: boolean;
  targets: { seriesUid: string; sopInstanceUid: string | null; modality: string | null }[] | null;
  backend: {
    ok?: boolean;
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

  const jar = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID, `${PLUGIN_ID}.jar`);
  if (!fs.existsSync(jar)) {
    throw new Error(
      `JAR がありません: ${jar}\n` +
        `  cd automator/plugins/${PLUGIN_ID} && javac -cp ../../../backend/target/classes ` +
        `-d out src/com/vis/uvs/plugin/UvsPlugin.java && (cd out && jar cf ../${PLUGIN_ID}.jar com)`,
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

    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer.png") }).catch(() => {});
  } finally {
    await driver.stop().catch(() => {});
  }

  console.log(`\n===== UVS 骨組みプラグイン（段 2）実機検証 =====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

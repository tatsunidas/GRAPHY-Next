/*
 * 描画環境の検出（設定＞描画環境・3D ビューアのソフトウェア描画の印）の実機検証。
 * 設計: fw/render-environment-design.md
 *
 * 実行:  cd automator && npx tsx src/spike/renderEnvCheck.ts [positive|libgl|disable-gpu]
 *   positive     通常起動（正例）。種別が hardware になり、3D に印が出ない。
 *   libgl        環境変数 LIBGL_ALWAYS_SOFTWARE=1 で起動（負例）。
 *   disable-gpu  Electron 引数 --disable-gpu で起動（負例）。
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend）:
 *   正例: 種別 hardware ／ 設定の GPU 名が、ページ内で別に取った UNMASKED_RENDERER_WEBGL と一致 ／
 *         3D テクスチャ上限が getMax3dTextureSize() と一致 ／ 機能状態と GPU 一覧が出る ／
 *         3D を開いても印が無い ／ GPU メモリは「不明」 ／ 既存カテゴリの並びが変わらない
 *   負例: 🔴 **先に、実際に GPU 名が llvmpipe / SwiftShader になったことを確かめる。**
 *         なっていなければ起動の指定が効いていないので、以降の判定は「未達」に数える（合格にも失敗にもしない）。
 *         そのうえで 種別 software ／ 3D に印が出る ／ 印を押すと設定＞描画環境が開く
 *
 * 結果は 合格・失敗・未達 に分けて数える。3D を開くのは ~/graphy-demo-samples の CT（HCC_001/C-A-P）。
 * 患者情報は出力しない（件数・寸法・GPU 名だけを書く）。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package`）。
 *       ポートは環境変数 GRAPHY_AUTOMATOR_HTTP_PORT / _SCP_PORT / _VITE_PORT で他セッションと分けること。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, type DesktopLaunchOptions } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

type Mode = "positive" | "libgl" | "disable-gpu";
const MODES: Mode[] = ["positive", "libgl", "disable-gpu"];
const mode = (process.argv[2] ?? "positive") as Mode;
if (!MODES.includes(mode)) {
  console.error(`モードは ${MODES.join(" / ")} のどれかを指定してください（受け取った値: ${process.argv[2]}）`);
  process.exit(64);
}
const NEGATIVE = mode !== "positive";

const SAMPLE_DIR = path.join(os.homedir(), "graphy-demo-samples", "HCC_001", "C-A-P");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "render-env-check", mode);

/** 導入前（main）の設定カテゴリの id と順序。renderEnv は monitor の次に 1 つだけ入る。 */
const BASELINE_CATEGORY_ORDER = [
  "general", "overlay", "dicomSend", "qr", "report", "viewer", "data", "importWatch", "dicom",
  "texture", "security", "monitor", "ai", "compute", "plugins", "about",
];

const failures: string[] = [];
const unreached: string[] = [];
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
function notReached(label: string, why: string): void {
  console.log(`  [未達] ${label} — ${why}`);
  unreached.push(label);
}

/** ページ内で、アプリの実装とは別に WebGL2 を開いて GPU 名と 3D テクスチャ上限を読む。 */
async function rawProbe(page: Page, powerPreference: "default" | "high-performance") {
  return page.evaluate((pp) => {
    const gl = document.createElement("canvas").getContext("webgl2", { powerPreference: pp });
    if (!gl) return null;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const r = {
      renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null,
      max3d: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number,
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return r;
  }, powerPreference);
}

async function row(page: Page, id: string) {
  const loc = page.getByTestId(`renderenv-row-${id}`);
  await loc.waitFor({ state: "visible", timeout: 15_000 });
  return {
    value: (await loc.getAttribute("data-value")) ?? "",
    kind: await loc.getAttribute("data-kind"),
    text: ((await loc.textContent()) ?? "").trim(),
  };
}

async function openRenderEnvSettings(page: Page): Promise<void> {
  await page.getByTestId("mainscreen-menu-system").click();
  await page.getByTestId("menu-item-settings").click();
  await page.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("settings-cat-renderEnv").click();
  await page.getByTestId("renderenv-panel").waitFor({ state: "visible", timeout: 15_000 });
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(SAMPLE_DIR)) throw new Error(`サンプルが見つかりません: ${SAMPLE_DIR}`);

  const launch: DesktopLaunchOptions =
    mode === "libgl" ? { extraEnv: { LIBGL_ALWAYS_SOFTWARE: "1" } }
    : mode === "disable-gpu" ? { extraElectronArgs: ["--disable-gpu"] }
    : {};
  console.log(`モード: ${mode}  起動指定: ${JSON.stringify(launch)}`);

  const driver = new DesktopDriver({}, launch);
  const recorder = createStepRecorder();
  await driver.start();
  try {
    const page = driver.page;
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [renderer error] ${m.text().slice(0, 200)}`);
    });
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [SAMPLE_DIR]);
    console.log(`取り込み: imported=${imp.imported} skipped=${imp.skipped} failed=${imp.failed}`);
    check(imp.imported > 0 && imp.failed === 0, "サンプル CT を取り込めた", { imported: imp.imported, failed: imp.failed });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });

    // --- 前提（負例のみ）: 実際に GPU 名がソフトウェア描画になったか ---
    const rawHp = await rawProbe(page, "high-performance");
    const rawDef = await rawProbe(page, "default");
    console.log(`\nページ内で別に取った GPU 名: high-performance="${rawHp?.renderer}" default="${rawDef?.renderer}"`);
    let premiseOk = true;
    if (NEGATIVE) {
      premiseOk = !!rawHp?.renderer && /llvmpipe|swiftshader/i.test(rawHp.renderer);
      console.log(`\n[0] 前提: 起動指定でソフトウェア描画になったか`);
      if (premiseOk) console.log(`  [ok  ] GPU 名が実際にソフトウェア描画になった（${rawHp?.renderer}）`);
      else notReached(`起動指定 ${mode} で GPU 名が llvmpipe / SwiftShader になる`, `実際の GPU 名は "${rawHp?.renderer}"。以降の負例判定は行わない`);
    }

    // --- 設定＞描画環境 ---
    console.log("\n[1] 設定＞描画環境");
    await openRenderEnvSettings(page);
    const cats = await page.locator('[data-testid^="settings-cat-"]').evaluateAll((els) =>
      els.map((e) => (e.getAttribute("data-testid") ?? "").replace("settings-cat-", "")));
    console.log(`  カテゴリ: ${cats.join(", ")}`);
    const expected = [...BASELINE_CATEGORY_ORDER];
    expected.splice(expected.indexOf("monitor") + 1, 0, "renderEnv");
    check(JSON.stringify(cats) === JSON.stringify(expected), "🔴 既存カテゴリの id と順序が変わらず、renderEnv が monitor の次に入る", { cats, expected });
    const gpu = await row(page, "gpu");
    const gpuDef = await row(page, "gpu-default");
    const kind = await row(page, "kind");
    const webgl2 = await row(page, "webgl2");
    const max3d = await row(page, "max3d");
    const mem = await row(page, "memory");
    const gpuMem = await row(page, "gpu-memory");
    const features = await row(page, "features");
    const devices = await row(page, "devices");
    for (const [k, r] of Object.entries({ gpu, gpuDef, kind, webgl2, max3d, mem, gpuMem, features, devices })) {
      console.log(`  ${k}: value="${r.value}" ${r.kind ? `kind=${r.kind} ` : ""}text="${r.text.slice(0, 140)}"`);
    }
    await page.getByTestId("settings-dialog").screenshot({ path: path.join(OUT_DIR, "settings-renderenv.png") });

    // 共通: 値が出ている・GPU メモリは推測しない・機能状態と一覧が出る（A3 のデスクトップ側）
    check(gpuMem.value === "" && /不明|Unknown/.test(gpuMem.text), "GPU メモリは「不明（ブラウザから取得できない）」と出る", gpuMem.text);
    check(features.value !== "" && /webgl2/.test(features.text), "機能状態（webgl2 ほか）が出る", features.text);
    check(/vendor 0x/.test(devices.text), "GPU の一覧が出る", devices.text);
    check(Number(mem.value) > 0, "搭載メモリが出る", mem.value);
    check(/\d+ MB/.test(mem.text), "ボリューム構築の上限が出る", mem.text);

    // 3D テクスチャ上限: getMax3dTextureSize()（アプリ内のモジュール）と一致するか
    const appMax3d = await page.evaluate(async (mod) => {
      const m = await import(/* @vite-ignore */ mod);
      return m.getMax3dTextureSize() as number | null;
    }, "/src/viewer/volumeMemory.ts");
    console.log(`  getMax3dTextureSize()=${appMax3d} 別に取った MAX_3D_TEXTURE_SIZE(high-performance)=${rawHp?.max3d}`);
    check(appMax3d !== null && String(appMax3d) === max3d.value, "🔴 max3dTexture が getMax3dTextureSize() と一致する", { appMax3d, row: max3d.value });
    check(rawHp !== null && String(rawHp.max3d) === max3d.value, "max3dTexture が別に取った値と一致する（A4: ガードの寸法が導入前と同じ）", { raw: rawHp?.max3d, row: max3d.value });
    check(webgl2.value === "true", "WebGL2 が利用できる", webgl2.value);

    if (!NEGATIVE) {
      console.log("\n[2] 正例の判定");
      check(kind.value === "hardware" && kind.kind === "hardware", "🔴 種別が hardware", kind);
      check(rawHp !== null && gpu.value === rawHp.renderer, "🔴 GPU 名が、別に取った UNMASKED_RENDERER_WEBGL と一致する", { row: gpu.value, raw: rawHp?.renderer });
      check(rawDef !== null && gpuDef.value === rawDef.renderer, "既定側の GPU 名も一致する", { row: gpuDef.value, raw: rawDef?.renderer });
      check(!/llvmpipe|swiftshader|softpipe/i.test(gpu.value), "GPU 名がソフトウェア描画ではない", gpu.value);
      check((await page.getByTestId("renderenv-software-warning").count()) === 0, "設定画面にソフトウェア描画の警告が出ない");
    } else if (premiseOk) {
      console.log("\n[2] 負例の判定");
      check(kind.value === "software" && kind.kind === "software", "🔴 種別が software", kind);
      check(rawHp !== null && gpu.value === rawHp.renderer, "GPU 名が別に取った値と一致する", { row: gpu.value, raw: rawHp?.renderer });
      check((await page.getByTestId("renderenv-software-warning").count()) === 1, "設定画面にソフトウェア描画の警告が出る");
    } else {
      notReached("負例: 種別が software になる", "前提が成り立たなかったため");
      notReached("負例: 設定画面に警告が出る", "前提が成り立たなかったため");
    }

    // コピー（JSON がクリップボードに入る）
    await page.context().grantPermissions?.(["clipboard-read", "clipboard-write"]).catch(() => {});
    await page.getByTestId("renderenv-copy").click();
    await page.getByTestId("renderenv-copy-result").waitFor({ timeout: 5_000 });
    const copyResult = (await page.getByTestId("renderenv-copy-result").textContent()) ?? "";
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    let clipJson: { kind?: string } | null = null;
    try { clipJson = clip ? JSON.parse(clip) : null; } catch { /* 下の check で失敗にする */ }
    check(clipJson !== null && clipJson.kind === kind.value, "「結果をコピー」で JSON がクリップボードに入り、種別が画面と一致する", { copyResult, kind: clipJson?.kind });

    // 設定を閉じる
    await page.getByTestId("dialog-close-button").click();

    // --- 3D ---
    console.log("\n[3] 3D ビューア");
    await openFirstSeriesInViewer(page, recorder);
    const v3d = await driver.waitForNewPage(() => page.locator('button[title="3D Viewer"]').click(), (url) => url.includes("viewer3d"));
    v3d.on("console", (m) => {
      if (m.type() === "error") console.log(`  [3d error] ${m.text().slice(0, 200)}`);
    });
    await v3d.locator('[data-testid="viewer3d-mode-slab"]').waitFor({ timeout: 120_000 });
    await v3d.waitForTimeout(NEGATIVE ? 12_000 : 8_000);
    const v3dText = await v3d.evaluate(() => document.body.innerText);
    const opened = !/再試行|Retry/.test(v3dText);
    check(opened, "3D がエラーなく開く", v3dText.slice(0, 200).replace(/\s+/g, " "));
    // 印の有無を見る前に、この画面の種別判定が終わっていることを確かめる（「無い」と「まだ読めていない」を分ける）
    const kind3d = await v3d.evaluate(async (mod) => {
      const m = await import(/* @vite-ignore */ mod);
      return (await m.loadRenderEnvSummary()).kind as string;
    }, "/src/viewer/renderEnvReport.ts");
    console.log(`  3D ウィンドウの種別: ${kind3d}`);
    const badge = v3d.getByTestId("viewer3d-software-badge");
    await v3d.screenshot({ path: path.join(OUT_DIR, "viewer3d.png") });
    if (!NEGATIVE) {
      check(kind3d === "hardware", "3D ウィンドウの種別も hardware（印の有無を見る前提）", kind3d);
      check((await badge.count()) === 0, "🔴 正例では 3D ヘッダにソフトウェア描画の印が出ない");
    } else if (premiseOk) {
      check(kind3d === "software", "3D ウィンドウの種別も software（前提）", kind3d);
      check((await badge.count()) === 1 && (await badge.isVisible()), "🔴 3D ヘッダにソフトウェア描画の印が出る");
      await badge.click();
      const opened2 = await v3d.getByTestId("renderenv-panel").waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false);
      check(opened2, "印を押すと設定＞描画環境が開く");
      await v3d.screenshot({ path: path.join(OUT_DIR, "viewer3d-badge-settings.png") });
      const k = await v3d.getByTestId("renderenv-row-kind").getAttribute("data-kind");
      check(k === "software", "開いた設定の種別行も software", k);
    } else {
      notReached("負例: 3D ヘッダに印が出る", "前提が成り立たなかったため");
      notReached("負例: 印を押すと設定＞描画環境が開く", "前提が成り立たなかったため");
    }
    await v3d.close().catch(() => {});
  } finally {
    await driver.stop();
  }
}

main()
  .catch((e) => {
    console.log(`\n[FAIL] 例外: ${String(e).slice(0, 600)}`);
    failures.push(`例外: ${String(e).slice(0, 200)}`);
  })
  .finally(() => {
    console.log(`\n結果 (${mode}): 合格 ${passed} / 失敗 ${failures.length} / 未達 ${unreached.length}`);
    if (failures.length) console.log(`失敗:\n  - ${failures.join("\n  - ")}`);
    if (unreached.length) console.log(`未達:\n  - ${unreached.join("\n  - ")}`);
    console.log(`スクリーンショット: ${OUT_DIR}`);
    process.exit(failures.length > 0 ? 1 : 0);
  });

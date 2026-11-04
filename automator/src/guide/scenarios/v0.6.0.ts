/*
 * v0.6.0 操作ガイド: v0.5.2 以降の主な新機能のうち、次の 3 題材を撮る（2026-11-04 に利用者が選んだ）。
 *   1. ROI の扱い: グループ化（一括の表示・ロック・選択・合算）、複数 ROI のコピー・貼り付け
 *   2. 全患者タイル（患者を並べて比べる）と、複数シリーズの連結
 *   3. 管理: 自動削除（条件・試算・有効化の確認）と、受信時の匿名化の設定
 * AI アシスタントは「構築中」とだけ本文に書く（撮らない）。
 *
 * デスクトップ版を 1 回起動して全部を撮る（設定の自動削除はデスクトップ版だけ）。
 * 利用者のデータに触れないよう、automator/.results/guide-v0.6.0 を置き場にする（毎回作り直す）。
 * - データ: HCC_001〜003（GRAPHY_GUIDE_SAMPLES。無ければ GRAPHY_GUIDE_DATA）、連結は make-stitch-phantom.py の合成 CT
 * - 🔴 自動削除は**撮影の用の使い捨て DB でだけ**動かす。有効化の確認ダイアログは「キャンセル」で閉じ、
 *   「有効にする」「今すぐ実行」は押さない（実際に消える）。試算は何も消さない。
 * - ポートは他のセッションと重ならない 28710 番台（run.ts の web 側は GRAPHY_AUTOMATOR_*_PORT で別に指定する）。
 * - 🔴 ページごとに失敗を記録し、最後に一覧で出す。撮れなかった機能は、ガイドに載せない。
 * 本文は docs/release-guides/v0.6.0/guide.html。番号の順はそちらの説明の順と合わせる。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "@playwright/test";

import { dismissStartupDialogs } from "../../common/dismissDialogs.js";
import { killProcessTree } from "../../common/processUtils.js";
import { AUTOMATOR_ROOT } from "../../fixtures/manifest.js";
import type { MarkTarget, Scenario } from "../run.js";

const REPO = path.resolve(AUTOMATOR_ROOT, "..");
const DESKTOP_DIR = path.join(REPO, "desktop");
const FRONTEND_DIR = path.join(REPO, "frontend");
const ROOT = path.join(AUTOMATOR_ROOT, ".results", "guide-v0.6.0");
const APP_DIR = path.join(ROOT, "app");
const SAMPLES = process.env.GRAPHY_GUIDE_SAMPLES ?? process.env.GRAPHY_GUIDE_DATA ?? path.join(process.env.HOME ?? "", "graphy-demo-samples");
const PORT = 28710;
const SCP_PORT = 28711;
const VITE_PORT = 28713;

async function fit(page: Page, width = 1280, height = 720): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(800);
}

/** 置き場と HOME より上のパスを「…」にする（画面の文字だけ。データは変えない）。 */
async function hidePaths(page: Page): Promise<void> {
  await page.evaluate((roots) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      for (const r of roots) if (r && n.textContent?.includes(r)) n.textContent = n.textContent.split(r).join("…");
    }
  }, [ROOT, process.env.HOME ?? ""]);
}

async function waitHttp(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* 起動待ち */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`応答がありません: ${url}`);
}

async function findWindow(app: ElectronApplication, pred: (url: string) => boolean, timeoutMs: number): Promise<Page> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const w = app.windows().find((x) => pred(x.url()));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("窓が見つかりません");
}

async function importPaths(base: string, paths: string[]): Promise<unknown> {
  const r = await fetch(`${base}/api/import/paths`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }) });
  return r.json();
}

async function studies(base: string): Promise<{ studyInstanceUid: string; patientId: string }[]> {
  return (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId: string }[];
}

/** 2D ビューアの canvas 上で、キャンバスの左上からの位置 from から d だけドラッグする（v0.5.0 と同じ方法）。 */
async function drag(page: Page, from: [number, number], d: [number, number]): Promise<void> {
  await page.evaluate(([f, d]) => {
    const canvas = document.querySelector('[data-testid="viewer2d-canvas-host"] canvas') as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    // tsx が内側の名前付き関数に __name を差し込み、ページ側で落ちるので、関数を作らずに並べて送る
    const seq: [string, number, number, number][] = [["pointermove", f[0], f[1], 0], ["pointerdown", f[0], f[1], 1]];
    for (let i = 1; i <= 12; i++) seq.push(["pointermove", f[0] + (d[0] * i) / 12, f[1] + (d[1] * i) / 12, 1]);
    seq.push(["pointerup", f[0] + d[0], f[1] + d[1], 0]);
    for (const [type, x, y, b] of seq) {
      const c = { bubbles: true, cancelable: true, composed: true, clientX: r.left + x, clientY: r.top + y, button: 0, buttons: b };
      canvas.dispatchEvent(new PointerEvent(type, { ...c, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      canvas.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), c));
    }
  }, [from, d] as const);
  await page.waitForTimeout(600);
}

/** メニューの項目を押す。選択中のツールは「✓ 矩形 ROI」のように印が付くので、印があってもなくても一致させる。 */
async function menu(page: Page, top: string, item: string): Promise<void> {
  await page.getByTestId(`viewer2d-menu-${top}`).click();
  const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const name = new RegExp(`^(✓\\s*)?${escaped}$`);
  await page.getByRole("button", { name }).first().click();
  await page.waitForTimeout(500);
}

/** 要素が、いま画面に見えている領域（開いているダイアログの内側）に収まっているかを確かめる。収まらなければ失敗にする。 */
async function expectInside(page: Page, inner: Locator, outer: Locator, what: string): Promise<void> {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  if (!a || !b) throw new Error(`${what}: 要素が見つかりません`);
  if (a.y < b.y || a.y + a.height > b.y + b.height) throw new Error(`${what}: ダイアログの外にはみ出しています（スクロールが足りません）`);
  void page;
}

/** 設定ダイアログの中身を、要素が上端に来るまでスクロールする。 */
async function scrollToTop(loc: Locator): Promise<void> {
  await loc.evaluate((el) => el.scrollIntoView({ block: "start" }));
}

const scenario: Scenario = async ({ shot }) => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(APP_DIR, { recursive: true });
  // 起動時の利用条件の同意（#354）は、撮影の前に済んだことにしておく（出たままだと以降の操作が全部吸われる）
  fs.writeFileSync(
    path.join(APP_DIR, "settings.json"),
    JSON.stringify({ "dicom.localAePort": String(SCP_PORT), "legal.researchUseConsent": JSON.stringify({ version: 1, acceptedAt: new Date().toISOString() }) }, null, 2),
  );
  const stitchDir = path.join(ROOT, "stitch-phantom");
  const mk = spawnSync(process.env.PYTHON ?? "python3", [path.join(AUTOMATOR_ROOT, "scripts", "make-stitch-phantom.py"), stitchDir], { encoding: "utf8" });
  if (mk.status !== 0) throw new Error(`つなぎ合わせのファントムを作れません: ${mk.stderr}`);

  const failed: string[] = [];
  const captured: string[] = [];
  /** 画面を初期状態へ（開いたままの窓・ダイアログを閉じる）。main の準備ができてから差し替える。 */
  let reset: () => Promise<void> = async () => undefined;
  const section = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      captured.push(name);
    } catch (e) {
      failed.push(`${name}: ${String((e as Error).message).split("\n")[0]}`);
      console.log(`  [撮れず] ${name}: ${String((e as Error).message).split("\n")[0]}`);
      for (const w of app?.windows() ?? []) {
        await w.screenshot({ path: path.join(ROOT, `fail-${name}-${w.url().includes("2dviewer") ? "viewer" : "main"}.png`) }).catch(() => undefined);
      }
      await reset().catch(() => undefined);
    }
  };

  let vite: ChildProcess | null = null;
  let app: ElectronApplication | null = null;
  try {
    // win32: Node >= 20.12 は .cmd を shell 無しで spawn すると EINVAL で落ちる（desktopDriver と同じ扱い）
    vite = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev", "--", "--port", String(VITE_PORT), "--strictPort"], {
      cwd: FRONTEND_DIR,
      stdio: "ignore",
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
      env: { ...process.env, VITE_BACKEND_URL: `http://localhost:${PORT}` },
    });
    await waitHttp(`http://localhost:${VITE_PORT}/`, 60_000);

    const electronPath = createRequire(path.join(DESKTOP_DIR, "package.json"))("electron") as unknown as string;
    app = await electron.launch({
      executablePath: electronPath,
      args: [DESKTOP_DIR, "--no-sandbox"],
      cwd: APP_DIR,
      env: { ...process.env, GRAPHY_DEV: "1", GRAPHY_BACKEND_PORT: String(PORT), GRAPHY_DEV_SERVER_URL: `http://localhost:${VITE_PORT}` },
    });
    const main = await findWindow(app, (u) => u.startsWith(`http://localhost:${VITE_PORT}`) && !u.includes("#"), 120_000);
    const base = `http://localhost:${PORT}`;
    await waitHttp(`${base}/api/status`, 180_000);
    await main.evaluate(() => localStorage.setItem("graphy.locale", "ja"));
    await main.reload();
    await main.waitForTimeout(3_000);
    main.on("dialog", (d) => void d.accept());
    for (const p of ["HCC_001", "HCC_002", "HCC_003"]) {
      console.log(`取り込み(${p}): ${JSON.stringify(await importPaths(base, [path.join(SAMPLES, p)]))}`);
    }
    const before = new Set((await studies(base)).map((s) => s.studyInstanceUid));
    console.log(`取り込み(連結用の合成 CT): ${JSON.stringify(await importPaths(base, [path.join(stitchDir, "a")]))}`);
    const stitchStudy = (await studies(base)).find((s) => !before.has(s.studyInstanceUid));
    console.log(`連結用の患者: ${stitchStudy?.patientId ?? "(見つからない)"}`);

    const mainUrl = `http://localhost:${VITE_PORT}/`;
    reset = async (): Promise<void> => {
      // 開いたままの窓（ビューア）を閉じる。残ると、次に開く窓が新しくならない
      for (const w of app!.windows()) if (w !== main) await w.close().catch(() => undefined);
      await main.goto(mainUrl);
      await main.waitForTimeout(3_000);
      await dismissStartupDialogs(main);
      await fit(main);
    };
    await reset();

    /** 患者のスタディ＞シリーズを選び、2D ビューアの窓を開く（desc が空なら先頭のシリーズ）。 */
    const openViewer = async (patientId: string, desc?: string): Promise<Page> => {
      await main.getByTestId("search-patientid-input").fill(patientId);
      await main.getByTestId("search-allperiod-chip").click();
      await main.getByTestId("search-submit-button").click();
      await main.locator('[data-testid^="study-row-"]').first().click({ timeout: 20_000 });
      const rows = main.locator('[data-testid^="series-row-"]', desc ? { hasText: desc } : undefined);
      await rows.first().click({ timeout: 20_000 });
      const wait = app!.waitForEvent("window", { timeout: 30_000 });
      await main.getByTestId("viewer2d-toolbar-button").click();
      const viewer = await wait;
      viewer.on("dialog", (d) => void d.accept());
      await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
      await fit(viewer);
      await viewer.waitForTimeout(3_000);
      return viewer;
    };

    // ── 1. ROI の扱い: グループ化と、コピー・貼り付け ──
    await section("roi-group", async () => {
      const viewer = await openViewer("HCC_001", "PRE LIVER");
      const box = await viewer.locator('[data-testid="viewer2d-canvas-host"] canvas').first().boundingBox();
      if (!box) throw new Error("2D の画像がありません");
      // 肝臓が大きく写る Z 32 まで送る（先頭のスライスは骨盤寄りで肝臓が無い）
      await viewer.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let k = 0; k < 31; k++) {
        await viewer.mouse.wheel(0, 100);
        await viewer.waitForTimeout(250);
      }
      await viewer.waitForTimeout(1_000);
      // 矩形 2 つと円 1 つ。始点を変える（同じ場所から始めると、描かずに今ある ROI をつかむ）
      await menu(viewer, "roi", "矩形 ROI");
      await drag(viewer, [box.width * 0.37, box.height * 0.3], [40, 40]);
      await viewer.keyboard.press("Escape");
      await menu(viewer, "roi", "矩形 ROI");
      await drag(viewer, [box.width * 0.5, box.height * 0.42], [50, 35]);
      await viewer.keyboard.press("Escape");
      await menu(viewer, "roi", "円 ROI");
      await drag(viewer, [box.width * 0.44, box.height * 0.62], [30, 0]);
      await viewer.keyboard.press("Escape");
      await menu(viewer, "roiTools", "ROI マネージャ");
      await viewer.getByTestId("roi-row-select").first().waitFor({ state: "visible", timeout: 20_000 });
      const nRows = await viewer.getByTestId("roi-row-select").count();
      if (nRows < 2) throw new Error(`ROI の行が ${nRows} 件しかありません`);
      await viewer.getByTestId("roi-row-select").nth(0).check();
      await viewer.getByTestId("roi-row-select").nth(1).check();
      await viewer.waitForTimeout(500);
      await shot(viewer, "roi-group-make", [
        { at: viewer.getByTestId("roi-row-select").nth(0), side: "left" },
        { at: viewer.getByTestId("roi-group-make"), side: "left" },
      ]);
      await viewer.getByTestId("roi-group-make").click();
      await viewer.getByTestId("roi-group-head").first().waitFor({ state: "visible", timeout: 10_000 });
      await viewer.getByTestId("roi-group-lock").first().click();
      await viewer.waitForTimeout(800);
      const head = viewer.getByTestId("roi-group-head").first();
      // 見出しの右のボタン（表示・ロック・全選択・合算）は隣り合っていて、番号が重なる。1 つの枠にまとめて囲む
      const parts = await Promise.all(["roi-group-visible", "roi-group-lock", "roi-group-select", "roi-group-stats"].map((id) => head.getByTestId(id).boundingBox()));
      if (parts.some((b) => !b)) throw new Error("グループ見出しのボタンが見つかりません");
      const bs = parts as NonNullable<(typeof parts)[number]>[];
      const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
      const x1 = Math.max(...bs.map((b) => b.x + b.width)), y1 = Math.max(...bs.map((b) => b.y + b.height));
      await viewer.evaluate(([x, y, w, h]) => {
        const d = document.createElement("div");
        d.id = "guide-union";
        d.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;pointer-events:none`;
        document.body.appendChild(d);
      }, [x0, y0, x1 - x0, y1 - y0] as const);
      await shot(viewer, "roi-group", [
        { at: head.getByTestId("roi-group-name"), side: "left" },
        { at: viewer.locator("#guide-union"), side: "top" },
      ]);
      await viewer.evaluate(() => document.getElementById("guide-union")?.remove());
      // グループを選んでコピーし、別のスライスへ貼り付ける
      await head.getByTestId("roi-group-lock").click(); // ロックを外す（貼り付けは元のまま動く）
      await head.getByTestId("roi-group-select").click();
      await menu(viewer, "roiTools", "ROI をコピー");
      await viewer.waitForTimeout(500);
      await viewer.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let k = 0; k < 4; k++) {
        await viewer.mouse.wheel(0, 100);
        await viewer.waitForTimeout(250);
      }
      await viewer.waitForTimeout(800);
      await menu(viewer, "roiTools", "ROI を貼り付け");
      await viewer.waitForTimeout(1_200);
      await shot(viewer, "roi-paste", [
        viewer.getByTestId("viewer2d-menu-roiTools"),
        { at: viewer.getByTestId("viewer2d-toast"), side: "left" },
      ]);
      await viewer.close();
      await reset();
    });

    // ── 2. 全患者タイルと、複数シリーズの連結 ──
    await section("all-patients", async () => {
      const viewer = await openViewer("HCC_001", "PRE LIVER");
      const panel = viewer.getByTestId("left-panel");
      await shot(viewer, "left-panel", [
        { at: viewer.getByTestId("left-panel-toggle"), side: "left" },
        { at: panel.getByTestId("left-open-list"), side: "left" },
      ]);
      for (const pid of ["HCC_002", "HCC_003"]) {
        const input = panel.getByPlaceholder(/患者\s*ID/).first();
        await input.fill(pid);
        await input.press("Enter");
        await panel.getByText("▸").first().click({ timeout: 20_000 });
        const add = panel.getByTestId("series-toggle").last();
        await add.waitFor({ state: "visible", timeout: 20_000 });
        await add.click();
        await viewer.waitForTimeout(1_500);
      }
      await viewer.waitForFunction(() => document.querySelectorAll('[data-testid="series-viewer-root"]').length >= 3, null, { timeout: 60_000 });
      await viewer.locator('[data-testid="series-viewer-root"]').nth(1).click();
      await viewer.waitForTimeout(1_500);
      await shot(viewer, "all-patients", [
        { at: viewer.getByTestId("viewer2d-mode-global"), side: "left" },
        { at: viewer.getByTestId("patient-legend"), side: "left" },
        { at: viewer.getByTestId("tile-patient-label").first(), side: "left" },
      ]);
      await viewer.close();
      await reset();
    });
    await section("concat", async () => {
      if (!stitchStudy) throw new Error("連結用のファントムが取り込まれていません");
      const viewer = await openViewer(stitchStudy.patientId);
      const panel = viewer.getByTestId("left-panel");
      const picks = panel.getByTestId("series-concat-pick");
      await picks.first().waitFor({ state: "visible", timeout: 20_000 });
      await picks.nth(0).check();
      await picks.nth(1).check();
      await viewer.waitForTimeout(500);
      await panel.getByTestId("series-concat-open").click();
      const dlg = viewer.getByTestId("open-concat-dialog");
      await dlg.waitFor({ state: "visible", timeout: 20_000 });
      await viewer.waitForTimeout(1_500);
      await shot(viewer, "concat-dialog", [
        { at: panel.getByTestId("left-picked-list"), side: "left" },
        { at: dlg.getByTestId("open-concat-ok"), side: "left" },
        { at: dlg.getByTestId("open-concat-joint").first(), side: "left" },
        { at: dlg.getByTestId("open-concat-confirm"), side: "left" },
      ]);
      await dlg.getByTestId("open-concat-confirm").click();
      await viewer.getByTestId("series-concat-banner").waitFor({ state: "visible", timeout: 60_000 });
      await viewer.waitForTimeout(2_000);
      await shot(viewer, "concat-open", [{ at: viewer.getByTestId("series-concat-banner"), side: "left" }]);
      await viewer.close();
      await reset();
    });

    // ── 3. 管理: 自動削除と、受信時の匿名化（使い捨て DB。有効化・実行は押さない） ──
    const openSettings = async (cat: string): Promise<void> => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-settings").click();
      await main.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
      await main.getByTestId(`settings-cat-${cat}`).click();
    };
    await section("retention", async () => {
      await openSettings("retention");
      const panel = main.getByTestId("retention-panel");
      await panel.waitFor({ state: "visible", timeout: 20_000 });
      // 受信から 3 ヶ月と、保管量の上限（小さな値にして、試算に検査が並ぶようにする）
      await panel.getByTestId("retention-days-on").check();
      await panel.getByTestId("retention-days-unit").selectOption("month");
      await panel.getByTestId("retention-days").fill("3");
      await panel.getByTestId("retention-max-on").check();
      await panel.getByTestId("retention-max").fill("0.05");
      // ダイアログの本文は高さが固定（500px）でスクロールする。条件の行から「条件を保存」までが見える位置へ
      await scrollToTop(panel.getByTestId("retention-days-on"));
      await main.waitForTimeout(500);
      const dialog = main.getByTestId("settings-dialog");
      await expectInside(main, panel.getByTestId("retention-save"), dialog, "条件を保存");
      await expectInside(main, panel.getByTestId("retention-days"), dialog, "期間の入力");
      await hidePaths(main);
      await shot(main, "retention-conditions", [
        { at: panel.getByTestId("retention-days"), side: "left" },
        { at: panel.getByTestId("retention-days-unit"), side: "left" },
        { at: panel.getByTestId("retention-days-equiv"), side: "left" },
        { at: panel.getByTestId("retention-save"), side: "left" },
      ]);
      await panel.getByTestId("retention-save").click();
      await main.waitForTimeout(800);
      await panel.getByTestId("retention-preview").click();
      await panel.getByTestId("retention-preview-result").waitFor({ state: "visible", timeout: 60_000 });
      await main.waitForTimeout(800);
      await panel.getByTestId("retention-preview-result").scrollIntoViewIfNeeded();
      // この PC のディスク容量（参考欄）は、資料に載せる値ではないので隠す
      await main.evaluate(() => {
        const el = document.querySelector('[data-testid="retention-reference"]') as HTMLElement | null;
        if (el) el.style.visibility = "hidden";
      });
      await hidePaths(main);
      await shot(main, "retention-preview", [
        { at: panel.getByTestId("retention-preview"), side: "left" },
        { at: panel.getByTestId("retention-preview-table"), side: "left" },
        { at: panel.getByTestId("retention-enable"), side: "left" },
      ]);
      // 有効化の確認ダイアログまで。「有効にする」は押さず、キャンセルで閉じる
      await panel.getByTestId("retention-enable").click();
      const confirm = main.getByTestId("retention-confirm");
      await confirm.waitFor({ state: "visible", timeout: 10_000 });
      await main.waitForTimeout(500);
      await shot(main, "retention-confirm", [
        { at: confirm.getByTestId("retention-confirm-cancel"), side: "left" },
      ]);
      await confirm.getByTestId("retention-confirm-cancel").click();
      await reset();
    });
    await section("receive-anon", async () => {
      await openSettings("dicomSend");
      const panel = main.getByTestId("recv-anon-panel");
      const dialog = main.getByTestId("settings-dialog");
      await panel.getByTestId("recv-anon-enabled").check();
      await panel.getByTestId("recv-anon-confirm").check();
      // 上半分: 有効にする・内容の確認
      await scrollToTop(panel.getByTestId("recv-anon-enabled"));
      await main.waitForTimeout(500);
      await expectInside(main, panel.getByTestId("recv-anon-confirm"), dialog, "内容の確認");
      await shot(main, "receive-anon", [
        { at: panel.getByTestId("recv-anon-enabled"), side: "left" },
        { at: panel.getByTestId("recv-anon-confirm"), side: "left" },
      ]);
      // 下半分: 接頭辞・保存・鍵の書き出し
      await scrollToTop(panel.getByTestId("recv-anon-prefix"));
      await main.waitForTimeout(500);
      await expectInside(main, panel.getByTestId("recv-anon-save"), dialog, "保存");
      await expectInside(main, panel.getByTestId("recv-anon-key-export"), dialog, "鍵の書き出し");
      await shot(main, "receive-anon-save", [
        { at: panel.getByTestId("recv-anon-prefix"), side: "left" },
        { at: panel.getByTestId("recv-anon-save"), side: "left" },
        { at: panel.getByTestId("recv-anon-key-export"), side: "left" },
      ]);
      // 保存はしない（撮影の DB でも、有効にしたまま残さない）
      await reset();
    });
  } finally {
    await app?.close().catch(() => undefined);
    if (vite) killProcessTree(vite);
  }
  console.log(`\n撮れた: ${captured.join(", ")}`);
  console.log(`撮れず: ${failed.length === 0 ? "なし" : failed.join(" / ")}`);
  if (failed.length > 0) throw new Error(`撮れなかったページがあります: ${failed.join(" / ")}`);
};

export default scenario;

/*
 * アシスタントのスキル（入力と確認つきの処理手順）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantSkillCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓。モデルは使わない（スキルの実行にモデルは要らない）。
 * 確かめること:
 *   1. 一覧に同梱 2 件が出る（出所の表示つき）
 *   2. 🔴 「CT 標準ウィンドウ巡回」: 確認のたびに止まり、［続ける］で次へ。W/L が 肺 → 軟部 → 骨 と**実際に変わる**
 *      （期待値は同じ preset を直接の操作で当てた W/L を別に測っておく）
 *   3. 🔴 確認で［ここで止める］→ 以降の操作は実行されない（W/L は肺のまま）。元に戻すで開始前の値に戻る
 *   4. 「指定スライス」: 開始前に preset を選び、途中の入力（ask）でスライス番号を答えると、そのスライスが表示される。
 *      範囲外の値は受け付けず、スライスは動かない
 *   5. 取り込み: 不正な JSON は拒否、正しい JSON は一覧に出て実行できる。削除できる（同梱は削除できない）
 *   6. 🔴 負例: 保存ファイルを書き換えて未知の操作・式を混ぜたスキルは、一覧の読み込みで落ちる／main を通して保存されても
 *      実行が拒否され、2D 窓は 1 つも動かない
 *   7. 🔴 他の窓（メイン・2D）からの list/save/delete は forbidden
 * 未達として残すもの: 実モデルからの開始（段 2）／プラグインのツールを含むスキル（段 3）／実 OS。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-skill-check");
const PORTS = { http: 19500, scp: 19501, vite: 19503 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Wl = { center: number; width: number } | null;
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;
const same = (a: Wl, b: Wl) => !!a && !!b && near(a.center, b.center) && near(a.width, b.width);

async function readWl(viewer: Page): Promise<Wl> {
  return viewer.evaluate(`(function(){ var p = window.__graphyDebug.getViewportProperties()[0]; return p && p.windowLevel ? { center: p.windowLevel.center, width: p.windowLevel.width } : null; })()`) as Promise<Wl>;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver(PORTS);
  try {
    await driver.start();
    const info = await driver.app.evaluate(({ dialog, app }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return { userData: app.getPath("userData") };
    });
    const skillFile = path.join(info.userData, "assistant-skills.json");
    if (fs.existsSync(skillFile)) fs.rmSync(skillFile);
    const main: Page = driver.page;
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await openFirstSeriesInViewer(main, createStepRecorder());
    const viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2500);

    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.setViewportSize({ width: 560, height: 820 });
    await sleep(600);
    const direct = async (id: string, params: Record<string, unknown> = {}) => {
      const r = await win.evaluate(([i, p]) => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<{ ok: boolean }> } }).graphyDesktop.assistantViewerCmd("spike", { kind: "action", id: i, params: p }), [id, params] as [string, Record<string, unknown>]);
      await viewer.waitForTimeout(500);
      return r;
    };
    const sliceNow = async () => Number(await viewer.getByTestId("dim-slider-z").first().inputValue());
    const sliceMax = Number(await viewer.getByTestId("dim-slider-z").first().getAttribute("max"));
    check(sliceMax >= 5, "前提: fixture のスライス数が 6 以上（スライス移動を確かめられる）", { sliceMax });

    // 期待値: 同じ preset を直接の操作で当てて W/L を測る（スキルの経路とは別）
    const ref: Record<string, Wl> = {};
    for (const p of ["lung", "soft", "bone"]) {
      await direct("applyWlPreset", { name: p });
      ref[p] = await readWl(viewer);
    }
    check(!!ref.lung && !!ref.soft && !!ref.bone && !same(ref.lung, ref.soft) && !same(ref.soft, ref.bone) && !same(ref.lung, ref.bone), "前提: 肺・軟部・骨の W/L は互いに違う（変化を見分けられる）", ref);
    await direct("setWindowLevel", { center: 40, width: 400 });
    const base = await readWl(viewer);
    check(!!base && near(base.center, 40) && near(base.width, 400), "前提: 開始前の W/L を 40/400 にした", base);

    // --- 1. 一覧 ---
    console.log("\n[1] 一覧");
    await win.getByTestId("assistant-skill-toggle").click();
    await win.getByTestId("assistant-skill-panel").waitFor({ state: "visible", timeout: 10_000 });
    const names = await win.getByTestId("assistant-skill-name").allTextContents();
    check(names.length === 2 && /CT 標準ウィンドウ巡回|CT window tour/.test(names[0]), "同梱の 2 件が出る", names);
    check((await win.getByTestId("assistant-skill-delete").count()) === 0, "同梱には削除ボタンが無い");
    await win.getByTestId("assistant-skill-detail").first().click();
    check(((await win.getByTestId("assistant-skill-steps").textContent()) ?? "").match(/確認|Confirm/) !== null, "手順の詳細に確認ステップが出る");
    await win.getByTestId("assistant-skill-detail").first().click();
    await win.screenshot({ path: path.join(OUT_DIR, "1-list.png") });

    const item = (id: string) => win.locator(`[data-testid="assistant-skill-item"][data-skill-id="${id}"]`);

    // --- 2. 巡回 ---
    console.log("\n[2] CT 標準ウィンドウ巡回");
    await item("ct-window-tour").getByTestId("assistant-skill-run").click();
    await win.getByTestId("assistant-skill-confirm").waitFor({ state: "visible", timeout: 15_000 });
    await viewer.waitForTimeout(400);
    check(same(await readWl(viewer), ref.lung), "🔴 1 つ目の確認で止まり、W/L は肺の値", await readWl(viewer));
    await win.screenshot({ path: path.join(OUT_DIR, "2-confirm.png") });
    await win.getByTestId("assistant-skill-confirm-yes").click();
    await win.getByTestId("assistant-skill-confirm-message").waitFor({ state: "visible", timeout: 15_000 });
    await viewer.waitForTimeout(500);
    check(same(await readWl(viewer), ref.soft), "🔴 続けると軟部の値になり、2 つ目の確認で止まる", await readWl(viewer));
    await win.getByTestId("assistant-skill-confirm-yes").click();
    await win.getByTestId("assistant-skill-msg").waitFor({ state: "visible", timeout: 15_000 });
    await viewer.waitForTimeout(500);
    check(same(await readWl(viewer), ref.bone), "🔴 最後まで進むと骨の値", await readWl(viewer));
    check(((await win.getByTestId("assistant-skill-msg").textContent()) ?? "").includes("3"), "完了の表示（操作 3 件）", await win.getByTestId("assistant-skill-msg").textContent());

    // --- 3. 確認で止める ---
    console.log("\n[3] 確認で止める・元に戻す");
    await win.getByTestId("assistant-skill-undo").click();
    await win.getByTestId("assistant-skill-msg").filter({ hasText: /元に戻し|Undone/ }).waitFor({ state: "visible", timeout: 10_000 });
    await viewer.waitForTimeout(500);
    check(same(await readWl(viewer), base), "🔴 元に戻すで開始前の 40/400 に戻る", await readWl(viewer));
    await item("ct-window-tour").getByTestId("assistant-skill-run").click();
    await win.getByTestId("assistant-skill-confirm").waitFor({ state: "visible", timeout: 15_000 });
    await win.getByTestId("assistant-skill-confirm-no").click();
    await win.getByTestId("assistant-skill-msg").filter({ hasText: /確認でやめ|checkpoint/ }).waitFor({ state: "visible", timeout: 10_000 });
    await viewer.waitForTimeout(800);
    check(same(await readWl(viewer), ref.lung), "🔴 止めた後は W/L が肺のまま（軟部・骨の操作が実行されていない）", await readWl(viewer));
    check((await win.getByTestId("assistant-skill-confirm").count()) === 0, "確認カードが閉じる");
    await win.getByTestId("assistant-skill-undo").click();
    await viewer.waitForTimeout(600);
    check(same(await readWl(viewer), base), "止めた分も元に戻せる", await readWl(viewer));

    // --- 4. 指定スライス ---
    console.log("\n[4] 指定スライス（開始前の入力 + 途中の入力）");
    const slice0 = await sliceNow();
    await item("slice-review").getByTestId("assistant-skill-run").click();
    await win.getByTestId("assistant-skill-form").waitFor({ state: "visible", timeout: 10_000 });
    check((await win.getByTestId("assistant-skill-field-slice").count()) === 0, "途中で尋ねる入力（slice）は開始前の欄に出ない");
    await win.getByTestId("assistant-skill-field-preset").selectOption("bone");
    await win.screenshot({ path: path.join(OUT_DIR, "4-form.png") });
    await win.getByTestId("assistant-skill-start").click();
    await win.getByTestId("assistant-skill-ask").waitFor({ state: "visible", timeout: 15_000 });
    await viewer.waitForTimeout(400);
    check(same(await readWl(viewer), ref.bone), "🔴 開始前に選んだ preset（骨）が適用されてから尋ねられる", await readWl(viewer));
    await win.getByTestId("assistant-skill-ask-input").fill("-1");
    await win.getByTestId("assistant-skill-ask-ok").click();
    check((await win.getByTestId("assistant-skill-ask").count()) === 1 && ((await win.getByTestId("assistant-skill-msg").textContent()) ?? "").match(/正しくありません|not valid/) !== null, "🔴 範囲外の値は受け付けず、尋ね続ける", await win.getByTestId("assistant-skill-msg").textContent());
    check((await sliceNow()) === slice0, "範囲外の値ではスライスは動かない");
    await win.getByTestId("assistant-skill-ask-input").fill("4");
    await win.getByTestId("assistant-skill-ask-ok").click();
    await win.getByTestId("assistant-skill-confirm").waitFor({ state: "visible", timeout: 15_000 });
    await viewer.waitForTimeout(500);
    const s4 = await sliceNow();
    check(s4 === 4, "🔴 答えたスライス（4）が表示される", { slice0, s4 });
    await win.screenshot({ path: path.join(OUT_DIR, "4-confirm.png") });
    await win.getByTestId("assistant-skill-confirm-yes").click();
    await win.getByTestId("assistant-skill-msg").filter({ hasText: /最後まで|Ran to the end/ }).waitFor({ state: "visible", timeout: 10_000 });
    await win.getByTestId("assistant-skill-undo").click();
    await viewer.waitForTimeout(600);

    // --- 5. 取り込み・削除 ---
    console.log("\n[5] 取り込みと削除");
    const imp = win.getByTestId("assistant-skill-import");
    await imp.setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{ not json") });
    await win.getByTestId("assistant-skill-msg").filter({ hasText: /取り込めませんでした|Could not import/ }).waitFor({ state: "visible", timeout: 10_000 });
    check(true, "壊れた JSON は拒否される");
    const lt = (s: string) => ({ ja: s, en: s });
    const evilImport = { schemaVersion: 1, id: "evil-imp", title: lt("e"), description: lt("e"), inputs: [], steps: [{ kind: "tool", id: "deleteAll", params: {} }] };
    await imp.setInputFiles({ name: "evil.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(evilImport)) });
    await win.getByTestId("assistant-skill-msg").filter({ hasText: /unknown-action/ }).waitFor({ state: "visible", timeout: 10_000 });
    check((await win.getByTestId("assistant-skill-name").count()) === 2, "🔴 未知の操作を含むスキルは取り込めない（一覧は 2 件のまま）");
    const mine = { schemaVersion: 1, id: "my-flip", title: lt("自分: 左右反転と反転"), description: lt("テスト用"), inputs: [], steps: [{ kind: "tool", id: "flipH", params: {} }, { kind: "tool", id: "invert", params: {} }] };
    await imp.setInputFiles({ name: "mine.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(mine)) });
    await item("my-flip").waitFor({ state: "visible", timeout: 10_000 });
    check(fs.existsSync(skillFile) && JSON.parse(fs.readFileSync(skillFile, "utf8")).skills.length === 1, "取り込んだスキルが userData/assistant-skills.json に保存される");
    await item("my-flip").getByTestId("assistant-skill-run").click();
    await win.getByTestId("assistant-skill-msg").filter({ hasText: /最後まで|Ran to the end/ }).waitFor({ state: "visible", timeout: 15_000 });
    await viewer.waitForTimeout(500);
    const inv = await viewer.evaluate(`(function(){ var p = window.__graphyDebug.getViewportProperties()[0]; return p && p.invert; })()`);
    check(inv === true, "🔴 取り込んだスキルを実行すると白黒反転が実際に掛かる", { inv });
    await win.getByTestId("assistant-skill-undo").click();
    await viewer.waitForTimeout(500);
    const inv2 = await viewer.evaluate(`(function(){ var p = window.__graphyDebug.getViewportProperties()[0]; return p && p.invert; })()`);
    check(inv2 === false, "元に戻すで反転が外れる", { inv2 });
    await item("my-flip").getByTestId("assistant-skill-delete").click();
    await item("my-flip").waitFor({ state: "detached", timeout: 10_000 });
    check(JSON.parse(fs.readFileSync(skillFile, "utf8")).skills.length === 0, "削除するとファイルからも消える");

    // --- 6. 書き換え ---
    console.log("\n[6] 負例: 書き換えられたスキル");
    const tampered = {
      version: 1,
      skills: [
        mine,
        { schemaVersion: 1, id: "evil-file", title: lt("evil"), description: lt("evil"), inputs: [], steps: [{ kind: "run", cmd: "calc.exe" }] },
        { schemaVersion: 1, id: "evil-expr", title: lt("expr"), description: lt("expr"), inputs: [], steps: [{ kind: "tool", id: "goToSlice", params: { index: { $expr: "1+1" } } }] },
      ],
    };
    fs.writeFileSync(skillFile, JSON.stringify(tampered));
    await win.getByTestId("assistant-skill-toggle").click();
    await win.getByTestId("assistant-skill-toggle").click();
    await item("my-flip").waitFor({ state: "visible", timeout: 10_000 });
    const names2 = await win.getByTestId("assistant-skill-name").allTextContents();
    check(names2.length === 3 && !names2.some((n) => n === "evil" || n === "expr"), "🔴 main の読み込みで、形の不正な 2 件（未知の kind・式）は一覧に出ない", names2);
    // main の形検査は通るが registry に無い操作（renderer から保存された想定）→ 実行が拒否される
    const slipped = await win.evaluate((s) => (window as unknown as { graphyDesktop: { assistantSkillsSave: (s: unknown) => Promise<{ ok: boolean }> } }).graphyDesktop.assistantSkillsSave(s), {
      schemaVersion: 1, id: "slip", title: { ja: "slip", en: "slip" }, description: { ja: "s", en: "s" }, inputs: [],
      steps: [{ kind: "tool", id: "flipH", params: {} }, { kind: "tool", id: "wipeDisk", params: {} }],
    });
    check(slipped.ok === true, "前提: main は形だけ見るので保存はされる（実行側の検証を確かめるため）");
    await win.getByTestId("assistant-skill-toggle").click();
    await win.getByTestId("assistant-skill-toggle").click();
    await item("slip").waitFor({ state: "visible", timeout: 10_000 });
    const invB = await viewer.evaluate(`(function(){ var p = window.__graphyDebug.getViewportProperties()[0]; return p && p.invert; })()`);
    const blockedMsg = (await item("slip").getByTestId("assistant-skill-blocked").textContent()) ?? "";
    check(await item("slip").getByTestId("assistant-skill-run").isDisabled() && /unknown-action/.test(blockedMsg), "🔴 検証に通らないスキルは理由つきで［実行］が止まっている", blockedMsg);
    await viewer.waitForTimeout(500);
    const flippedAfter = await viewer.evaluate(`(function(){ var p = window.__graphyDebug.getViewportProperties()[0]; return p && p.invert; })()`);
    check(flippedAfter === invB, "先頭の正しい操作（flipH）も実行されていない", { invB, flippedAfter });
    await win.screenshot({ path: path.join(OUT_DIR, "6-rejected.png") });

    // --- 7. forbidden ---
    console.log("\n[7] 他の窓から");
    const before = fs.readFileSync(skillFile, "utf8");
    for (const [label, page] of [["メイン窓", main], ["2D 窓", viewer]] as const) {
      const r = await page.evaluate(() => {
        const d = (window as unknown as { graphyDesktop: { assistantSkillsList: () => Promise<{ error?: string }>; assistantSkillsSave: (m: unknown) => Promise<{ error?: string }>; assistantSkillsDelete: (i: string) => Promise<{ error?: string }> } }).graphyDesktop;
        return Promise.all([d.assistantSkillsList(), d.assistantSkillsSave({ schemaVersion: 1 }), d.assistantSkillsDelete("slip")]);
      });
      check(r.every((x) => x.error === "forbidden"), `🔴 ${label}からの list/save/delete は forbidden`, r);
    }
    check(fs.readFileSync(skillFile, "utf8") === before, "forbidden の呼び出しでファイルは変わらない");
  } finally {
    await driver.stop();
  }
  const failed = summary();
  console.log("  [未達] 実モデルからのスキル開始（段 2）／プラグインのツールを含むスキル（段 3）／実 OS");
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed, unreached: 3 }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });

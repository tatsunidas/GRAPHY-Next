/*
 * 中・右ボタンのツール割り当て（設定）を、実アプリで確かめるスパイク。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_VITE_PORT=18293 timeout 600 npx tsx src/spike/mouseBindingsCheck.ts <ファントムのフォルダ> [組の名前=a]
 *   ファントムは automator/scripts/make-stitch-phantom.py で作る。前に backend の jar を作り直しておく
 *   （古い jar を掴まないため）。ポートは 18290（http）・18291（scp）・18293（vite）。
 *
 * 測るもの（ビューアの実測値。見た目の文言ではなく数値）:
 *   W/L = __graphyDebug.getViewportProperties()[0].windowLevel（中心・幅）
 *   ズーム = getViewportGeometry()[0].camera.parallelScale（小さいほど拡大）
 *   パン = 同 camera.focalPoint
 * ボタンの入力は Playwright の実マウスイベント（左・中・右）。
 *
 * 経路: ①既定のまま（設定に何も入れない） ②設定画面で右=W/L に変える（ビューアを開いたまま）
 *       ③中=なし・右=ズーム ④ビューアを開き直しても保存した割り当てが効く ⑤既定に戻す
 *       ⑥サイドボタン（戻る・進む）: 既定（なし）では何も起きない → 戻る=パン・進む=ズームに設定 → 効く・既定動作を止める
 *          → 開き直しても効く → なしに戻す。サイドボタンの入力は CDP の Input.dispatchMouseEvent（button: back/forward）。
 *       ⑦サイドボタンのクリックで操作: 戻る=白黒反転・進む=リセット（クリックで実行・ドラッグでは実行しない・ツール／なしでは実行しない）、
 *          戻る=同期 OFF／進む=同期 ON（タイル見出しの同期ボタンの色で見る。1 タイルのみ。2 タイルは未達）。
 *          ⚠️ CDP の入力はレンダラへ直接入るので、OS 側の「戻る」（窓の履歴移動）は再現できない。実機のマウスで別に確かめる。
 * 各経路で「効くはずのものが効く」と「効かないはずのものが動かない」の両方を見る。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { createStepRecorder } from "../checklist/types.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "mouse-bindings-check");
const [root, setName = "a"] = process.argv.slice(2);
if (!root) throw new Error("使い方はファイル先頭を参照");

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

interface State { wlC: number; wlW: number; scale: number; fx: number; fy: number; fz: number }
async function state(v: Page): Promise<State> {
  return v.evaluate(() => {
    const dbg = (window as any).__graphyDebug;
    const wl = dbg.getViewportProperties()[0].windowLevel;
    const cam = dbg.getViewportGeometry()[0].camera;
    return { wlC: wl.center, wlW: wl.width, scale: cam.parallelScale, fx: cam.focalPoint[0], fy: cam.focalPoint[1], fz: cam.focalPoint[2] };
  });
}
const EPS = 1e-6;
const wlChanged = (a: State, b: State) => Math.abs(a.wlC - b.wlC) > EPS || Math.abs(a.wlW - b.wlW) > EPS;
const zoomChanged = (a: State, b: State) => Math.abs(a.scale - b.scale) > EPS;
const panChanged = (a: State, b: State) => Math.abs(a.fx - b.fx) + Math.abs(a.fy - b.fy) + Math.abs(a.fz - b.fz) > EPS;

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver({ http: 18290, scp: 18291 });
  await d.start();
  try {
    const http = d.ports.http;
    await resetDb(http);
    await importPaths(http, [path.join(root, setName)]);
    const main = d.page;
    await main.reload();
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await openFirstSeriesInViewer(main, createStepRecorder());
    let v = await d.waitForNewPage(
      () => main.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    const tile = () => v.getByTestId("series-viewer-root").first();
    const readyViewer = async () => {
      await tile().waitFor({ state: "visible", timeout: 30_000 });
      await v.waitForTimeout(2000);
    };
    await readyViewer();

    const host = () => tile().locator('[data-testid="viewer2d-canvas-host"]').first();
    /** 画像の中央から (dx,dy) だけ、指定ボタンでドラッグして、前後の状態を返す。 */
    const drag = async (button: "left" | "middle" | "right", dx: number, dy: number) => {
      const box = (await host().boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const before = await state(v);
      await v.mouse.move(cx, cy);
      await v.mouse.down({ button });
      await v.mouse.move(cx + dx, cy + dy, { steps: 10 });
      await v.mouse.up({ button });
      await v.waitForTimeout(500);
      return { before, after: await state(v) };
    };
    const rightClickMenu = async () => {
      const box = (await host().boundingBox())!;
      await v.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3, { button: "right" });
      await v.waitForTimeout(600);
      const shown = (await v.getByTestId("frame-ctx-tags").count()) > 0;
      if (shown) await v.keyboard.press("Escape");
      await v.waitForTimeout(300);
      return shown;
    };
    const setMouseSetting = async (key: "mouse.middle" | "mouse.right" | "mouse.back" | "mouse.forward", value: string) => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-settings").click();
      await main.getByTestId("settings-dialog").waitFor({ state: "visible", timeout: 10_000 });
      await main.getByTestId("settings-cat-viewer").click();
      await main.getByTestId(`settings-field-${key}`).selectOption(value);
      await main.waitForTimeout(800);
      await main.getByTestId("dialog-close-button").click();
      await main.getByTestId("settings-dialog").waitFor({ state: "hidden", timeout: 5000 });
    };

    // ① 既定のまま
    console.log("① 既定のまま（設定に何も入れていない）");
    await v.screenshot({ path: path.join(OUT_DIR, "1-default-start.png") });
    let r = await drag("right", 0, -60);
    check(zoomChanged(r.before, r.after), "右ドラッグでズームが変わる", r);
    // 計測用（段 3 の調査）: 右ドラッグのあとに右クリックのメニューが開いていないか。開く場合は、サイドボタンとは無関係な既存の挙動（旧コードと比べて確認する）。
    console.log(`  [info] ① 右ドラッグ後のフレームメニュー: ${(await v.getByTestId("frame-ctx-tags").count()) > 0 ? "開いている（既存の挙動。変更前の版でも同じ）" : "開いていない"}`);
    if ((await v.getByTestId("frame-ctx-tags").count()) > 0) await v.keyboard.press("Escape");
    // ズームは焦点をわずかに動かす（旧コードでも同じ値: 0.0127。2026-11-22 に旧・新で比べて確認）。パンとは別物なので、ここは W/L だけを見る。
    check(!wlChanged(r.before, r.after), "右ドラッグで W/L は変わらない（負例）", r);
    r = await drag("middle", 40, 25);
    check(panChanged(r.before, r.after), "中ドラッグでパンが変わる", r);
    check(!wlChanged(r.before, r.after) && !zoomChanged(r.before, r.after), "中ドラッグで W/L・ズームは変わらない（負例）", r);
    r = await drag("left", 30, -30);
    check(wlChanged(r.before, r.after), "左ドラッグで W/L が変わる", r);
    check(!zoomChanged(r.before, r.after) && !panChanged(r.before, r.after), "左ドラッグでズーム・パンは変わらない（負例）", r);
    check(await rightClickMenu(), "右クリック（動かさない）でフレームのメニューが出る");

    // ② 設定画面で右=W/L（ビューアは開いたまま）
    console.log("② 右ボタン=W/L（ビューアを開いたまま設定画面で変更）");
    await setMouseSetting("mouse.right", "windowLevel");
    await v.waitForTimeout(500);
    r = await drag("right", 30, -30);
    check(wlChanged(r.before, r.after), "右ドラッグで W/L が変わる（開き直さずに反映）", r);
    check(!zoomChanged(r.before, r.after) && !panChanged(r.before, r.after), "右ドラッグでもうズーム（焦点の移動も）しない（負例）", r);
    r = await drag("middle", 30, 20);
    check(panChanged(r.before, r.after), "中ドラッグは引き続きパン", r);
    check(await rightClickMenu(), "右クリック（動かさない）のメニューは今まで通り出る");
    await v.screenshot({ path: path.join(OUT_DIR, "2-right-wl.png") });

    // ③ 中=なし・右=ズーム
    console.log("③ 中ボタン=なし、右ボタン=ズーム");
    await setMouseSetting("mouse.middle", "none");
    await setMouseSetting("mouse.right", "zoom");
    await v.waitForTimeout(500);
    r = await drag("middle", 40, 25);
    check(!panChanged(r.before, r.after) && !wlChanged(r.before, r.after) && !zoomChanged(r.before, r.after), "中ドラッグは何も起きない（負例）", r);
    r = await drag("right", 0, -50);
    check(zoomChanged(r.before, r.after) && !wlChanged(r.before, r.after), "右ドラッグはズーム", r);

    // ④ ビューアを開き直しても、保存した割り当てが効く
    console.log("④ ビューアを開き直す");
    await v.close();
    v = await d.waitForNewPage(
      () => main.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await readyViewer();
    r = await drag("middle", 40, 25);
    check(!panChanged(r.before, r.after), "開き直しても中ドラッグは何も起きない（保存した設定が効く）", r);
    r = await drag("right", 0, -50);
    check(zoomChanged(r.before, r.after), "開き直しても右ドラッグはズーム", r);
    await v.screenshot({ path: path.join(OUT_DIR, "4-reopened.png") });

    // ⑤ 既定に戻す
    console.log("⑤ 既定（中=パン）に戻す");
    await setMouseSetting("mouse.middle", "pan");
    await v.waitForTimeout(500);
    r = await drag("middle", 40, 25);
    check(panChanged(r.before, r.after), "中=パンに戻すと中ドラッグでパンが変わる", r);

    // ⑥ サイドボタン（戻る・進む）
    console.log("⑥ サイドボタン（戻る＝第 4・進む＝第 5）");
    const installLog = async () =>
      v.evaluate(() => {
        const w = window as any;
        w.__sideLog = [];
        document.addEventListener("mouseup", (e) => w.__sideLog.push({ b: e.button, dp: e.defaultPrevented }), false);
      });
    const sideLog = async (): Promise<{ b: number; dp: boolean }[]> => v.evaluate(() => (window as any).__sideLog);
    const nav = async () => v.evaluate(() => ({ href: location.href, len: history.length }));
    let cdp = await v.context().newCDPSession(v);
    const dragSide = async (which: "back" | "forward", dx: number, dy: number) => {
      const box = (await host().boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const mask = which === "back" ? 8 : 16;
      const before = await state(v);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy, buttons: 0 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: which, buttons: mask, clickCount: 1 });
      for (let i = 1; i <= 10; i++) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx + (dx * i) / 10, y: cy + (dy * i) / 10, button: which, buttons: mask });
      }
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx + dx, y: cy + dy, button: which, buttons: 0, clickCount: 1 });
      await v.waitForTimeout(500);
      return { before, after: await state(v) };
    };
    const nav0 = await nav();
    await installLog();
    r = await dragSide("back", 40, 25);
    check(!panChanged(r.before, r.after) && !zoomChanged(r.before, r.after) && !wlChanged(r.before, r.after), "既定（なし）: 戻るドラッグは何も起きない（負例）", r);
    r = await dragSide("forward", 0, -50);
    check(!panChanged(r.before, r.after) && !zoomChanged(r.before, r.after) && !wlChanged(r.before, r.after), "既定（なし）: 進むドラッグは何も起きない（負例）", r);
    let log = await sideLog();
    check(log.length === 2 && log.every((x) => x.dp === false), "既定（なし）: サイドボタンの既定動作は止めない（defaultPrevented=false）", log);

    await setMouseSetting("mouse.back", "pan");
    await setMouseSetting("mouse.forward", "zoom");
    await v.waitForTimeout(500);
    r = await dragSide("back", 40, 25);
    check(panChanged(r.before, r.after), "戻る=パン: 戻るドラッグでパンが変わる（開き直さずに反映）", r);
    check(!wlChanged(r.before, r.after), "戻る=パン: W/L は変わらない（負例）", r);
    r = await dragSide("forward", 0, -50);
    check(zoomChanged(r.before, r.after), "進む=ズーム: 進むドラッグでズームが変わる", r);
    check(!wlChanged(r.before, r.after), "進む=ズーム: W/L は変わらない（負例）", r);
    log = await sideLog();
    const added = log.slice(2);
    check(added.length === 2 && added.every((x) => x.dp === true), "割り当て後: サイドボタンの既定動作を止める（defaultPrevented=true）", added);
    const nav1 = await nav();
    check(nav1.href === nav0.href && nav1.len === nav0.len, "ページの URL と履歴の長さが変わらない", { nav0, nav1 });
    // 既存の左・中・右は変わらない（回帰）
    r = await drag("right", 0, -40);
    check(zoomChanged(r.before, r.after) && !wlChanged(r.before, r.after), "回帰: 右ドラッグは従来どおりズーム", r);
    r = await drag("middle", 40, 25);
    check(panChanged(r.before, r.after) && !zoomChanged(r.before, r.after), "回帰: 中ドラッグは従来どおりパン", r);
    r = await drag("left", 30, -30);
    check(wlChanged(r.before, r.after) && !zoomChanged(r.before, r.after), "回帰: 左ドラッグは従来どおり W/L", r);
    await v.screenshot({ path: path.join(OUT_DIR, "6-side-assigned.png") });

    // 開き直しても保存した割り当てが効く
    await v.close();
    v = await d.waitForNewPage(
      () => main.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await readyViewer();
    cdp = await v.context().newCDPSession(v);
    await installLog();
    r = await dragSide("back", 40, 25);
    check(panChanged(r.before, r.after), "開き直しても戻る=パンが効く", r);
    check((await sideLog()).every((x) => x.dp === true), "開き直しても既定動作を止める");

    // なしに戻す
    await setMouseSetting("mouse.back", "none");
    await setMouseSetting("mouse.forward", "none");
    await v.waitForTimeout(500);
    r = await dragSide("back", 40, 25);
    check(!panChanged(r.before, r.after) && !zoomChanged(r.before, r.after) && !wlChanged(r.before, r.after), "なしに戻すと戻るドラッグは何も起きない", r);
    check((await sideLog()).slice(-1)[0]?.dp === false, "なしに戻すと既定動作を止めない");

    // ⑦ サイドボタンのクリックで操作
    console.log("⑦ サイドボタンのクリックで操作（戻る=白黒反転・進む=リセット）");
    const inv = async (): Promise<boolean | null> => v.evaluate(() => (window as any).__graphyDebug.getViewportProperties()[0].invert);
    const clickSide = async (which: "back" | "forward", moveBy = 0) => {
      const box = (await host().boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const mask = which === "back" ? 8 : 16;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy, buttons: 0 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: which, buttons: mask, clickCount: 1 });
      if (moveBy) {
        for (let i = 1; i <= 10; i++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx + (moveBy * i) / 10, y: cy, button: which, buttons: mask });
      }
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx + moveBy, y: cy, button: which, buttons: 0, clickCount: 1 });
      await v.waitForTimeout(500);
    };
    // ⚠️ Linux では、右ボタンのドラッグのあとにフレームのメニューが開いたままになる（コンテキストメニューが押した時点で出るため、
    //    動かしたかどうかの判定が効かない）。サイドボタンとは無関係で、変更前の版（#753 より前）でも同じことを確認した。
    //    メニューが次の操作（タイルの追加など）を塞ぐので、この検査では Escape で閉じてから進める。
    const closeMenu = async () => {
      if ((await v.getByTestId("frame-ctx-tags").count()) > 0) await v.keyboard.press("Escape");
      await v.waitForTimeout(300);
    };
    const noMenu = async (label: string) =>
      check((await v.getByTestId("frame-ctx-tags").count()) === 0, `${label}: 右クリックのメニューが開いていない`);
    await noMenu("⑦ の開始時");
    await setMouseSetting("mouse.back", "cmd:invert");
    await setMouseSetting("mouse.forward", "cmd:reset");
    await v.waitForTimeout(500);
    const inv0 = await inv();
    await clickSide("back");
    await noMenu("戻るをクリックした後");
    const inv1 = await inv();
    check(inv0 !== null && inv1 === !inv0, "戻る=白黒反転: クリックで反転する", { inv0, inv1 });
    await v.screenshot({ path: path.join(OUT_DIR, "7-inverted.png") });
    await clickSide("back");
    check((await inv()) === inv0, "もう一度クリックで元に戻る", { now: await inv(), inv0 });
    await clickSide("back", 60); // ドラッグ
    check((await inv()) === inv0, "ドラッグ（動かして離す）では実行されない（負例）", { now: await inv() });
    await setMouseSetting("mouse.back", "pan");
    await v.waitForTimeout(300);
    await clickSide("back");
    check((await inv()) === inv0, "戻る=パン（ツール）に変えると、クリックでは何も実行されない（負例）");
    await setMouseSetting("mouse.back", "none");
    await v.waitForTimeout(300);
    await clickSide("back");
    check((await inv()) === inv0, "戻る=なし に変えると、クリックでは何も実行されない（負例）");

    // 進む=リセット: ズーム・パンを変えてからクリックで元に戻る
    await clickSide("forward"); // まずリセットして基準を取る
    const base = await state(v);
    await noMenu("リセット（進むのクリック）の後");
    await drag("right", 0, -60);
    await closeMenu(); // 右ドラッグのあとにメニューが開くのは Linux では旧コードでも同じ（下の注記）
    await drag("middle", 40, 25);
    await closeMenu();
    const moved = await state(v);
    check(zoomChanged(base, moved) && panChanged(base, moved), "（準備）ズームとパンを変えた", { base, moved });
    await clickSide("forward");
    const afterReset = await state(v);
    check(!zoomChanged(base, afterReset) && !panChanged(base, afterReset), "進む=リセット: クリックでズーム・パンが基準に戻る", { base, afterReset });
    await v.screenshot({ path: path.join(OUT_DIR, "7-reset.png") });
    await clickSide("back");
    await v.waitForTimeout(200);

    // 同期 OFF／ON（2 タイル）
    await closeMenu();
    await setMouseSetting("mouse.back", "cmd:syncOff");
    await setMouseSetting("mouse.forward", "cmd:syncOn");
    const syncColors = async () =>
      v.getByTestId("tile-sync-toggle").evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
    // 2 タイルでの確認は未達（2 本目のシリーズをタイルに足す手順を安定して通せなかった）。1 タイルで、同期ボタンの色の切り替えを見る。
    console.log("  [未達] 2 タイルでの同期の切り替え（この検査は 1 タイル）");
    await clickSide("forward"); // 同期 ON
    const on = await syncColors();
    await clickSide("back"); // 同期 OFF
    const off = await syncColors();
    check(on.length >= 1 && on.every((c) => c === on[0]) && off.every((c) => c === off[0]) && on[0] !== off[0], "戻る=同期 OFF／進む=同期 ON: 同期ボタンの色が切り替わる（1 タイル）", { on, off });
    await clickSide("forward");
    check(JSON.stringify(await syncColors()) === JSON.stringify(on), "進む=同期 ON で元の色に戻る", { now: await syncColors(), on });
    await v.screenshot({ path: path.join(OUT_DIR, "7-sync.png") });
    // 後片付け
    await setMouseSetting("mouse.back", "none");
    await setMouseSetting("mouse.forward", "none");
  } finally {
    await d.stop();
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

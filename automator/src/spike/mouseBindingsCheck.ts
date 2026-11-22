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
 *       ③中=なし・右=ズーム ④ビューアを開き直しても保存した割り当てが効く ⑤既定に戻す。
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
    const setMouseSetting = async (key: "mouse.middle" | "mouse.right", value: string) => {
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

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const wc = require("./windowControl");

/** BrowserWindow の状態遷移だけを真似る偽物。leave-full-screen は即時（or 遅延 or 来ない）に出す。 */
function fakeWin({ leaveEvent = "sync" } = {}) {
  const w = new EventEmitter();
  const s = { max: false, full: false, min: false, destroyed: false };
  w.isMaximized = () => s.max;
  w.isFullScreen = () => s.full;
  w.isMinimized = () => s.min;
  w.isDestroyed = () => s.destroyed;
  w.maximize = () => { s.max = true; };
  w.unmaximize = () => { s.max = false; };
  w.minimize = () => { s.min = true; };
  w.restore = () => { s.min = false; };
  w.setFullScreen = (on) => {
    s.full = on;
    w.emit(on ? "enter-full-screen" : "leave-full-screen-start");
    if (!on && leaveEvent === "sync") w.emit("leave-full-screen");
    if (!on && leaveEvent === "async") setTimeout(() => w.emit("leave-full-screen"), 20);
  };
  w.s = s;
  return w;
}
const st = (w) => wc.getState(w);

test("fullscreen: 入って、もう一度で抜ける（F11 と同じ切り替え）", async () => {
  const w = fakeWin();
  assert.deepEqual(await wc.apply(w, "fullscreen"), { maximized: false, fullscreen: true, minimized: false });
  assert.deepEqual(await wc.apply(w, "fullscreen"), { maximized: false, fullscreen: false, minimized: false });
});

test("restore: 最大化 → 通常の大きさ", async () => {
  const w = fakeWin();
  await wc.apply(w, "maximize");
  assert.equal(st(w).maximized, true);
  assert.deepEqual(await wc.apply(w, "restore"), { maximized: false, fullscreen: false, minimized: false });
});

test("restore: フルスクリーン → 通常の大きさ", async () => {
  const w = fakeWin();
  await wc.apply(w, "fullscreen");
  assert.deepEqual(await wc.apply(w, "restore"), { maximized: false, fullscreen: false, minimized: false });
});

test("restore: 最大化してからフルスクリーンにした場合も、通常の大きさまで戻る", async () => {
  const w = fakeWin();
  await wc.apply(w, "maximize");
  await wc.apply(w, "fullscreen");
  assert.deepEqual(st(w), { maximized: true, fullscreen: true, minimized: false });
  assert.deepEqual(await wc.apply(w, "restore"), { maximized: false, fullscreen: false, minimized: false });
});

test("maximize: フルスクリーン中なら抜けてから最大化する", async () => {
  const w = fakeWin();
  await wc.apply(w, "fullscreen");
  assert.deepEqual(await wc.apply(w, "maximize"), { maximized: true, fullscreen: false, minimized: false });
});

test("minimize → restore で最小化からも戻る", async () => {
  const w = fakeWin();
  assert.equal((await wc.apply(w, "minimize")).minimized, true);
  assert.equal((await wc.apply(w, "restore")).minimized, false);
});

test("fullscreen: 最小化中なら先に戻してからフルスクリーンにする", async () => {
  const w = fakeWin();
  await wc.apply(w, "minimize");
  assert.deepEqual(await wc.apply(w, "fullscreen"), { maximized: false, fullscreen: true, minimized: false });
});

test("leave-full-screen が遅れて来ても待ってから unmaximize する（macOS のアニメーション）", async () => {
  const w = fakeWin({ leaveEvent: "async" });
  await wc.apply(w, "maximize");
  await wc.apply(w, "fullscreen");
  assert.deepEqual(await wc.apply(w, "restore"), { maximized: false, fullscreen: false, minimized: false });
});

test("leave-full-screen が来なくても、上限で進む（固まらない）", async () => {
  const w = fakeWin({ leaveEvent: "never" });
  await wc.apply(w, "fullscreen");
  const t0 = Date.now();
  const r = await wc.apply(w, "restore", { leaveTimeoutMs: 50 });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.maximized, false);
});

test("未知の action は拒否・破棄済みの窓は null", async () => {
  await assert.rejects(() => wc.apply(fakeWin(), "close"), /unknown window action/);
  const w = fakeWin();
  w.s.destroyed = true;
  assert.equal(await wc.apply(w, "fullscreen"), null);
});

test("F11 判定: 修飾キー付き・自動リピート・keyUp・macOS は対象外", () => {
  const k = (o) => ({ type: "keyDown", key: "F11", ...o });
  assert.equal(wc.isFullScreenShortcut(k({}), "linux"), true);
  assert.equal(wc.isFullScreenShortcut(k({}), "win32"), true);
  assert.equal(wc.isFullScreenShortcut(k({ shift: true }), "linux"), false);
  assert.equal(wc.isFullScreenShortcut(k({ alt: true }), "linux"), false);
  assert.equal(wc.isFullScreenShortcut(k({ isAutoRepeat: true }), "linux"), false);
  assert.equal(wc.isFullScreenShortcut({ type: "keyUp", key: "F11" }, "linux"), false);
  assert.equal(wc.isFullScreenShortcut(k({ key: "F10" }), "linux"), false);
  assert.equal(wc.isFullScreenShortcut(k({}), "darwin"), false);
});

test("attachFullScreenShortcut: F11 でキーを消費して切り替える（負例: F10 は何もしない）", async () => {
  const w = fakeWin();
  w.webContents = new EventEmitter();
  wc.attachFullScreenShortcut(w, "linux");
  let prevented = 0;
  const ev = { preventDefault: () => { prevented++; } };
  w.webContents.emit("before-input-event", ev, { type: "keyDown", key: "F10" });
  assert.equal(prevented, 0);
  assert.equal(w.s.full, false);
  w.webContents.emit("before-input-event", ev, { type: "keyDown", key: "F11" });
  assert.equal(prevented, 1);
  assert.equal(w.s.full, true);
});

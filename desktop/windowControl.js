// GRAPHY-Next — ウィンドウの表示操作（Window メニュー・F11）。
//
// 純粋なモジュール（Electron を import しない）。BrowserWindow 互換のオブジェクトを受けて操作する。
// 状態の保存は windowState.js がイベント（maximize/unmaximize/enter-full-screen/leave-full-screen）に
// 追従しているので、ここでは保存に触れない。
//
// 用語: 「フルスクリーン」＝フレームレス最大化（setFullScreen）、「最大化」＝枠つきの通常の最大化。

const ACTIONS = ["fullscreen", "maximize", "minimize", "restore"];

// macOS のフルスクリーンは別 Space に移るアニメーションがあり、抜けるのに時間がかかる。
// イベントが来なくても進める上限（超えたら現在の状態のまま続ける）。
const FULLSCREEN_LEAVE_TIMEOUT_MS = 2000;

function getState(win) {
  return {
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
    minimized: win.isMinimized(),
  };
}

function waitForEvent(win, event, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      win.removeListener(event, finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    win.once(event, finish);
  });
}

async function leaveFullScreen(win, timeoutMs) {
  if (!win.isFullScreen()) return;
  const left = waitForEvent(win, "leave-full-screen", timeoutMs);
  win.setFullScreen(false);
  await left;
}

/**
 * action を適用して、適用後の状態を返す。
 *  - fullscreen: 切り替え（F11 と同じ）。入るとき最小化中なら先に戻す
 *  - maximize  : 通常の最大化。フルスクリーン中なら先に抜ける
 *  - minimize  : 最小化
 *  - restore   : フルスクリーン・最大化・最小化のどれからも、通常の大きさへ戻す
 */
async function apply(win, action, { leaveTimeoutMs = FULLSCREEN_LEAVE_TIMEOUT_MS } = {}) {
  if (!ACTIONS.includes(action)) throw new Error(`unknown window action: ${action}`);
  if (!win || win.isDestroyed()) return null;
  switch (action) {
    case "fullscreen":
      if (win.isFullScreen()) {
        await leaveFullScreen(win, leaveTimeoutMs);
      } else {
        if (win.isMinimized()) win.restore();
        win.setFullScreen(true);
      }
      break;
    case "maximize":
      await leaveFullScreen(win, leaveTimeoutMs);
      if (win.isMinimized()) win.restore();
      if (!win.isMaximized()) win.maximize();
      break;
    case "minimize":
      win.minimize();
      break;
    case "restore":
      await leaveFullScreen(win, leaveTimeoutMs);
      if (win.isMinimized()) win.restore();
      if (win.isMaximized()) win.unmaximize();
      break;
  }
  return win.isDestroyed() ? null : getState(win);
}

/** F11 だけ（修飾キー無し）の keyDown か。macOS のフルスクリーンは OS 標準（⌃⌘F）に任せる。 */
function isFullScreenShortcut(input, platform) {
  if (platform === "darwin") return false;
  return !!input && input.type === "keyDown" && input.key === "F11" &&
    !input.alt && !input.control && !input.meta && !input.shift && !input.isAutoRepeat;
}

/** win の F11 でフルスクリーンを切り替える。Electron 既定メニューの F11 と二重に切り替わらないよう、キーは消費する。 */
function attachFullScreenShortcut(win, platform = process.platform) {
  win.webContents.on("before-input-event", (event, input) => {
    if (!isFullScreenShortcut(input, platform)) return;
    event.preventDefault();
    apply(win, "fullscreen").catch(() => {});
  });
}

module.exports = { ACTIONS, getState, apply, isFullScreenShortcut, attachFullScreenShortcut, FULLSCREEN_LEAVE_TIMEOUT_MS };

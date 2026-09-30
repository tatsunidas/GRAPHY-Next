/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * **H30 — プラグイン専用ウィンドウ**（`fw/subtraction-design.md` §15.4）。
 *
 * 本体がウィンドウを開き、**中身の DOM だけプラグインに貸す**。後始末は本体が行う。
 *
 * <h3>🔴 「別ウィンドウ」ではなく「本体と同じ文書の中の窓」である</h3>
 *
 * 設計の初出は `GlamAnalysisScreen` と同じ「`window.open` / `desktop().openViewer()` で
 * 別ウィンドウ」を想定していたが、**この API の形とは両立しない**:
 *
 * - Electron の `openViewer()` は**別の BrowserWindow ＝ 別の JS コンテキスト**で、
 *   `container: HTMLElement` を渡すこと自体ができない。
 * - 仮に `window.open` で同一オリジンの別文書にしても、そこに Cornerstone のビューポートを
 *   置くと **RenderingEngine が文書ごとに要る**ことになり、
 *   「単一の共有 RenderingEngine」という前提（`CLAUDE.md` 絶対ルール 1・4）が崩れる。
 *
 * よってここは**同じ文書の中に浮かべる窓**として実装する。§11.2 の 4 面レイアウトは
 * これで十分に置ける（求められているのは広い作業面であって、OS のウィンドウではない）。
 *
 * <h3>出所を必ず出す</h3>
 *
 * タイトルバーに**プラグイン名を必ず表示する**。`showOverlay` が画像左下に
 * 「プラグイン: <名前>」を出しているのと同じ理由で、本体の画面と見分けがつかない状態を作らない
 * （§15.8）。プラグインからタイトルは指定できるが、**出所の表示は消せない**。
 */

/** プラグインへ渡すウィンドウのハンドル。 */
export interface PluginWindowHandle {
  /** プラグインが自由に使ってよい DOM。ここより外は触らせない。 */
  container: HTMLElement;
  /** 閉じる（本体側の後始末も走る）。 */
  close(): void;
  /** 閉じられたときに呼ばれる。ユーザーが × を押した場合も含む。 */
  onClose(listener: () => void): void;
  /** 既に閉じているか。 */
  readonly closed: boolean;
  /**
   * H52: × で閉じる前の確認。`fn` が文言を返したら、本体が窓の中に確認を出し、「閉じる」を選んだときだけ閉じる
   * （null なら確認なしで閉じる）。長い処理の途中で誤って閉じないために使う。`close()` を直接呼んだときは効かない。
   */
  setCloseGuard(fn: (() => string | null) | null): void;
  /** H52: この窓を最前面へ出す（同じものを 2 枚開かず、開いている窓を見せるときなど）。 */
  focus(): void;
}

export interface PluginWindowOptions {
  title?: string;
  width?: number;
  height?: number;
  /**
   * 出所の表示に使う文言（`viewer2d.plugin.overlayLabel` と同じもの）。
   * **本体が渡す**——プラグインからは指定させない（消せてしまうと §15.8 の意味が無い）。
   */
  originLabel?: string;
  /** 閉じるボタンの説明（本体が `common.close` を渡す）。 */
  closeLabel?: string;
  /** H52 の確認で「閉じない」ボタンの文言（本体が渡す）。 */
  keepOpenLabel?: string;
}

const CLASS = "graphy-plugin-window";
const open = new Set<{ close: () => void }>();
let styled = false;

function ensureStyles(): void {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const style = document.createElement("style");
  style.id = `${CLASS}-styles`;
  // セレクタは必ず `.graphy-plugin-window` から始める。プラグインのために足した CSS が
  // 本体の見た目を変えると、不具合の切り分けが一気に難しくなる。
  style.textContent = `
.${CLASS}{position:fixed;z-index:8000;display:flex;flex-direction:column;
  background:#1b1b1b;color:#ddd;border:1px solid #555;border-radius:4px;
  box-shadow:0 8px 32px rgba(0,0,0,.6);font:13px/1.5 system-ui,"Segoe UI",sans-serif;
  min-width:320px;min-height:200px;resize:both;overflow:hidden}
.${CLASS}__bar{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 10px;
  background:#2a2a2a;border-bottom:1px solid #555;cursor:move;user-select:none}
.${CLASS}__title{font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${CLASS}__origin{color:#8ab4f8;font-size:11px;white-space:nowrap}
.${CLASS}__close{background:none;border:0;color:#aaa;font-size:18px;line-height:1;cursor:pointer}
.${CLASS}__close:hover{color:#fff}
.${CLASS}__body{flex:1 1 auto;min-height:0;overflow:auto;position:relative}
.${CLASS}__guard{position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;
  background:rgba(10,20,30,.45)}
.${CLASS}__guard-box{background:#fff;color:#223;border-radius:8px;padding:14px 16px;max-width:min(440px,90%);
  box-shadow:0 8px 30px rgba(0,0,0,.35);font-size:13px;line-height:1.6}
.${CLASS}__guard-bar{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.${CLASS}__guard-bar button{padding:5px 12px;border-radius:6px;cursor:pointer;font:inherit;border:1px solid #cdd5de;background:#f4f7fa;color:#334}
.${CLASS}__guard-bar button.danger{background:#b3261e;border-color:#b3261e;color:#fff}
`;
  document.head.appendChild(style);
}

/** タイトルバーを掴んで動かす。画面外へ完全に逃がさない。 */
function makeDraggable(root: HTMLElement, bar: HTMLElement): void {
  let startX = 0;
  let startY = 0;
  let baseLeft = 0;
  let baseTop = 0;
  const onMove = (e: PointerEvent) => {
    const maxLeft = window.innerWidth - 80;
    const maxTop = window.innerHeight - 40;
    root.style.left = `${Math.min(maxLeft, Math.max(0, baseLeft + e.clientX - startX))}px`;
    root.style.top = `${Math.min(maxTop, Math.max(0, baseTop + e.clientY - startY))}px`;
  };
  const onUp = (e: PointerEvent) => {
    bar.releasePointerCapture?.(e.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  bar.addEventListener("pointerdown", (e: PointerEvent) => {
    if ((e.target as HTMLElement)?.tagName === "BUTTON") return;
    startX = e.clientX;
    startY = e.clientY;
    baseLeft = root.offsetLeft;
    baseTop = root.offsetTop;
    bar.setPointerCapture?.(e.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

/**
 * プラグイン専用ウィンドウを開く（H30）。
 *
 * @param plugin 出所の表示に使う（**プラグイン側から消せない**）。
 */
export function openPluginWindow(
  plugin: { id: string; name: string },
  opts: PluginWindowOptions = {},
): PluginWindowHandle {
  ensureStyles();
  const width = Math.min(window.innerWidth - 40, Math.max(320, opts.width ?? 1100));
  const height = Math.min(window.innerHeight - 40, Math.max(200, opts.height ?? 760));

  const root = document.createElement("div");
  root.className = CLASS;
  root.style.width = `${width}px`;
  root.style.height = `${height}px`;
  root.style.left = `${Math.max(0, Math.round((window.innerWidth - width) / 2))}px`;
  root.style.top = `${Math.max(0, Math.round((window.innerHeight - height) / 2))}px`;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", opts.title || plugin.name);

  const bar = document.createElement("div");
  bar.className = `${CLASS}__bar`;

  const title = document.createElement("span");
  title.className = `${CLASS}__title`;
  title.textContent = opts.title || plugin.name;

  // 出所の表示。プラグインが指定したタイトルとは**別に**出すので、
  // タイトルを本体機能らしく付けても出所は隠れない。
  const origin = document.createElement("span");
  origin.className = `${CLASS}__origin`;
  origin.textContent = opts.originLabel ?? `プラグイン: ${plugin.name}`;
  origin.title = plugin.id;

  const closeButton = document.createElement("button");
  closeButton.className = `${CLASS}__close`;
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.title = opts.closeLabel ?? "閉じる";

  const body = document.createElement("div");
  body.className = `${CLASS}__body`;

  bar.append(title, origin, closeButton);
  root.append(bar, body);
  document.body.appendChild(root);
  makeDraggable(root, bar);

  const listeners: Array<() => void> = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    open.delete(entry);
    root.remove();
    for (const listener of listeners) {
      // 1 つが投げても残りは呼ぶ。後始末が途中で止まるとビューポートが残る。
      try {
        listener();
      } catch (e) {
        console.error("[plugin-window] onClose listener failed", e);
      }
    }
  };
  const entry = { close };
  open.add(entry);

  // H52: × で閉じる前の確認（プラグインが処理中など）。文言はプラグインが決めるが、出すのは本体
  let guard: (() => string | null) | null = null;
  let guardShown: HTMLElement | null = null;
  const requestClose = () => {
    if (closed) return;
    let message: string | null = null;
    try {
      message = guard ? guard() : null;
    } catch (e) {
      console.error("[plugin-window] close guard failed", e);
    }
    if (!message) {
      close();
      return;
    }
    if (guardShown) return;
    const overlay = document.createElement("div");
    overlay.className = `${CLASS}__guard`;
    overlay.setAttribute("data-testid", "plugin-window-close-guard");
    const box = document.createElement("div");
    box.className = `${CLASS}__guard-box`;
    const text = document.createElement("div");
    text.textContent = message;
    const bar2 = document.createElement("div");
    bar2.className = `${CLASS}__guard-bar`;
    const stay = document.createElement("button");
    stay.type = "button";
    stay.textContent = opts.keepOpenLabel ?? "続ける";
    stay.setAttribute("data-testid", "plugin-window-close-guard-stay");
    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "danger";
    leave.textContent = opts.closeLabel ?? "閉じる";
    leave.setAttribute("data-testid", "plugin-window-close-guard-close");
    bar2.append(stay, leave);
    box.append(text, bar2);
    overlay.appendChild(box);
    root.appendChild(overlay);
    guardShown = overlay;
    stay.addEventListener("click", () => {
      overlay.remove();
      guardShown = null;
    });
    leave.addEventListener("click", close);
    stay.focus();
  };
  closeButton.addEventListener("click", requestClose);

  return {
    container: body,
    close,
    onClose: (listener) => listeners.push(listener),
    get closed() {
      return closed;
    },
    setCloseGuard: (fn) => {
      guard = fn;
    },
    focus: () => {
      if (!closed) document.body.appendChild(root); // 同じ z-index の中で最後に置いたものが上に出る
    },
  };
}

/**
 * 開いているプラグインウィンドウを全部閉じる。
 *
 * ビューアを閉じる / シリーズを切り替える側から呼ぶ。**プラグインの後始末を当てにしない**
 * ——プラグインが例外で落ちても、本体の画面に浮いたままの窓を残さないため。
 */
export function closeAllPluginWindows(): void {
  for (const entry of [...open]) entry.close();
}

/** テスト・診断用。開いている窓の数。 */
export function openPluginWindowCount(): number {
  return open.size;
}

/**
 * 確率カーブ（補間済み）と、**ドラッグできるしきい値ハンドル**。
 *
 * 🔴 **ハンドルを動かしてもサーバへ往復しない。** 再合成はフロントの `summaryComposer` が行う
 * （設計 §画面）。往復すると 1 回 2〜3 秒待たされ、しきい値を「探る」操作にならない。
 */
export interface ChartHandle {
  /** 補間済み確率を描き直す。 */
  setCurve(values: readonly number[]): void;
  /** しきい値の位置を描き直す（値は 0〜1）。 */
  setThreshold(v: number): void;
  /** 破棄（イベントを外す）。 */
  dispose(): void;
}

export interface ChartOptions {
  /** ドラッグ中・確定時に呼ばれる。0〜1 に丸めた値が渡る。 */
  onThreshold(v: number): void;
  height?: number;
}

const CURVE = "#2563eb";
const GRID = "#d4d4d8";
const HANDLE = "#dc2626";

export function createChart(root: HTMLElement, opts: ChartOptions): ChartHandle {
  const doc = root.ownerDocument;
  const wrap = doc.createElement("div");
  wrap.style.position = "relative";
  wrap.setAttribute("data-testid", "uvs-chart");

  const canvas = doc.createElement("canvas");
  const height = opts.height ?? 120;
  canvas.style.width = "100%";
  canvas.style.height = `${height}px`;
  canvas.style.display = "block";
  canvas.style.background = "#fff";
  canvas.style.border = "1px solid #e4e4e7";
  wrap.appendChild(canvas);

  // ハンドルは canvas の上に置いた実 DOM。**ポインタで掴める要素**にしておかないと、
  // 実機検査で「ドラッグした」ことにならない（v0.2.7 の反省: 押していない操作は守れない）。
  const handle = doc.createElement("div");
  handle.setAttribute("data-testid", "uvs-threshold-handle");
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-label", "probability threshold");
  handle.style.position = "absolute";
  handle.style.left = "0";
  handle.style.right = "0";
  handle.style.height = "10px";
  handle.style.marginTop = "-5px";
  handle.style.cursor = "ns-resize";
  handle.style.borderTop = `2px solid ${HANDLE}`;
  wrap.appendChild(handle);

  root.appendChild(wrap);

  let curve: readonly number[] = [];
  let threshold = 0.75;

  const draw = (): void => {
    const ratio = doc.defaultView?.devicePixelRatio ?? 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(height * ratio));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    // 0 / 0.5 / 1 の目盛り。
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    for (const v of [0, 0.5, 1]) {
      const y = Math.round(h - v * h) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (curve.length > 1) {
      ctx.strokeStyle = CURVE;
      ctx.lineWidth = Math.max(1, ratio);
      ctx.beginPath();
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * w;
        const y = h - Math.min(1, Math.max(0, curve[i])) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    handle.style.top = `${(1 - threshold) * height}px`;
    handle.setAttribute("aria-valuenow", threshold.toFixed(4));
  };

  const fromClientY = (clientY: number): number => {
    const rect = canvas.getBoundingClientRect();
    const v = 1 - (clientY - rect.top) / Math.max(1, rect.height);
    return Math.min(1, Math.max(0, v));
  };

  let dragging = false;
  const onDown = (e: PointerEvent): void => {
    dragging = true;
    handle.setPointerCapture?.(e.pointerId);
    opts.onThreshold(fromClientY(e.clientY));
    e.preventDefault();
  };
  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    opts.onThreshold(fromClientY(e.clientY));
  };
  const onUp = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture?.(e.pointerId);
  };
  handle.addEventListener("pointerdown", onDown);
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
  // カーブ上をクリックしてもしきい値を置ける（ハンドルを掴みに行かなくてよい）。
  canvas.addEventListener("pointerdown", (e) => opts.onThreshold(fromClientY(e.clientY)));

  return {
    setCurve(values) {
      curve = values;
      draw();
    },
    setThreshold(v) {
      threshold = Math.min(1, Math.max(0, v));
      draw();
    },
    dispose() {
      handle.removeEventListener("pointerdown", onDown);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      wrap.remove();
    },
  };
}

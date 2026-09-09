/**
 * カラーバー 5 本（採用・予測・カラー・静止・手動）。
 *
 * 🔴 **4 本は「なぜ落ちたか」を別々に見せる。** 1 本に混ぜると、同じフレームが
 * カラーでも静止でも落ちていることが見えなくなり、「足し合わせて総数」という誤解を招く
 * （実際には重なる）。
 *
 * クリック / ドラッグで手動の追加・除外を切り替える。
 */
import type { Frame1 } from "./indices";

export type BarKind = "final" | "pred" | "color" | "static" | "manual";

export interface BarsHandle {
  setFrameCount(n: number): void;
  set(kind: BarKind, frames: readonly Frame1[]): void;
  dispose(): void;
}

export interface BarsOptions {
  labels: Record<BarKind, string>;
  /** バー上での操作。`frame` は 1-based。採用バーのクリックで手動の追加/除外を切り替える。 */
  onToggle(frame: Frame1): void;
  /** バー上のホバー / クリックでプレビューを動かす。 */
  onSeek(frame: Frame1): void;
}

const COLORS: Record<BarKind, string> = {
  final: "#16a34a",
  pred: "#2563eb",
  color: "#f59e0b",
  static: "#8b5cf6",
  manual: "#dc2626",
};

const ORDER: BarKind[] = ["final", "pred", "color", "static", "manual"];

export function createBars(root: HTMLElement, opts: BarsOptions): BarsHandle {
  const doc = root.ownerDocument;
  const wrap = doc.createElement("div");
  wrap.setAttribute("data-testid", "uvs-bars");
  root.appendChild(wrap);

  let frameCount = 0;
  const sets: Record<BarKind, Set<number>> = {
    final: new Set(),
    pred: new Set(),
    color: new Set(),
    static: new Set(),
    manual: new Set(),
  };
  const canvases: Partial<Record<BarKind, HTMLCanvasElement>> = {};

  for (const kind of ORDER) {
    const row = doc.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "6px";
    row.style.margin = "2px 0";

    const label = doc.createElement("div");
    label.textContent = opts.labels[kind];
    label.style.width = "56px";
    label.style.fontSize = "11px";
    label.style.color = "#52525b";
    row.appendChild(label);

    const canvas = doc.createElement("canvas");
    canvas.setAttribute("data-testid", `uvs-bar-${kind}`);
    canvas.style.flex = "1";
    canvas.style.height = "14px";
    canvas.style.border = "1px solid #e4e4e7";
    canvas.style.cursor = "pointer";
    canvases[kind] = canvas;
    row.appendChild(canvas);
    wrap.appendChild(row);

    const frameAt = (clientX: number): Frame1 => {
      const rect = canvas.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
      const idx = Math.min(frameCount, Math.max(1, Math.round(t * (frameCount - 1)) + 1));
      return idx as Frame1;
    };
    let dragging = false;
    canvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      canvas.setPointerCapture?.(e.pointerId);
      const f = frameAt(e.clientX);
      opts.onSeek(f);
      opts.onToggle(f);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const f = frameAt(e.clientX);
      opts.onSeek(f);
      opts.onToggle(f);
    });
    const stop = (e: PointerEvent): void => {
      dragging = false;
      canvas.releasePointerCapture?.(e.pointerId);
    };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
  }

  const draw = (kind: BarKind): void => {
    const canvas = canvases[kind];
    if (!canvas) return;
    const ratio = doc.defaultView?.devicePixelRatio ?? 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const h = Math.max(1, Math.round(14 * ratio));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (frameCount <= 0) return;
    ctx.fillStyle = COLORS[kind];
    // 🔑 フレームは画素より多いことがある。**1 フレーム 1 本の線**で描くと消えるので、
    //    最低 1 画素幅を確保して塗る（見えない＝無いと読まれるのが一番悪い）。
    const unit = w / frameCount;
    const width = Math.max(1, unit);
    for (const f of sets[kind]) {
      ctx.fillRect((f - 1) * unit, 0, width, h);
    }
  };

  return {
    setFrameCount(n) {
      frameCount = n;
      for (const k of ORDER) draw(k);
    },
    set(kind, frames) {
      sets[kind] = new Set(frames as readonly number[]);
      draw(kind);
    },
    dispose() {
      wrap.remove();
    },
  };
}

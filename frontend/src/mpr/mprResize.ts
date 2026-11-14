/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * MPR の 3 面のセルのサイズ変化を見て、変わったときだけ（1 フレームに 1 回に束ねて）通知する。
 *
 * <p>MPR は 3 面を、読み出し行とヘッダーの操作部が**無い状態**で作り、その後 ready でそれらが現れてセルが縮む。
 * canvas の内部サイズは作った時のままなので、画像が縦に約 2.7% 潰れて表示され、ホバー・十字線の座標とずれた。
 * セルのサイズが変わったら `engine.resize()` で canvas を表示寸法へ合わせる。
 *
 * <p>幅か高さが 0 のセル（モバイルの 1 面表示で隠れた面など）は無視する。サイズが前回と同じ通知も無視する。
 *
 * @returns 解除関数
 */
export function observeResize(
  elements: ReadonlyArray<Element | null | undefined>,
  onResize: () => void,
  impl: {
    RO?: new (cb: ResizeObserverCallback) => ResizeObserver;
    raf?: (cb: () => void) => number;
    cancel?: (id: number) => void;
  } = {},
): () => void {
  const RO = impl.RO ?? ResizeObserver;
  const raf = impl.raf ?? ((cb: () => void) => requestAnimationFrame(cb));
  const cancel = impl.cancel ?? ((id: number) => cancelAnimationFrame(id));
  const last = new Map<Element, string>();
  let pending: number | null = null;
  let disposed = false;

  const ro = new RO((entries) => {
    let changed = false;
    for (const e of entries) {
      const w = Math.round(e.contentRect.width * 100) / 100;
      const h = Math.round(e.contentRect.height * 100) / 100;
      if (!(w > 0) || !(h > 0)) continue;
      const key = `${w}x${h}`;
      if (last.get(e.target) !== key) {
        last.set(e.target, key);
        changed = true;
      }
    }
    if (!changed || pending !== null || disposed) return;
    pending = raf(() => {
      pending = null;
      if (!disposed) onResize();
    });
  });
  for (const el of elements) if (el) ro.observe(el);

  return () => {
    disposed = true;
    if (pending !== null) cancel(pending);
    pending = null;
    ro.disconnect();
  };
}

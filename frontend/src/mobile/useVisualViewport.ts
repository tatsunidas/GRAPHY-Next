/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ソフトキーボードで縮んだ表示領域に追随する（`fw/mobile-ui-design.md` §5.3）。
 *
 * <p>⚠️ **iOS Safari はソフトキーボードが出ても layout viewport を縮めない。**
 * `position: fixed; inset: 0` のシェルは画面いっぱいのままで、下端（＝入力欄や保存ボタン）が
 * **キーボードの裏に隠れる**。`visualViewport` は「実際に見えている領域」を返すので、
 * その高さをシェルに反映する。
 *
 * <p>`visualViewport` 非対応（古い Android WebView 等）では `null` を返し、呼び出し側は
 * 従来どおり `inset: 0` のままにする（＝挙動を変えない）。
 */
import { useEffect, useState } from "react";

/** 現在の可視領域の高さ [px]。`visualViewport` が無ければ null。 */
export function useVisualViewportHeight(): number | null {
  const [height, setHeight] = useState<number | null>(() => readHeight());

  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : undefined;
    if (!vv) return;
    const onChange = () => setHeight(readHeight());
    vv.addEventListener("resize", onChange);
    // キーボードを出したままスクロールすると offsetTop が変わるので、こちらも見る。
    vv.addEventListener("scroll", onChange);
    return () => {
      vv.removeEventListener("resize", onChange);
      vv.removeEventListener("scroll", onChange);
    };
  }, []);

  return height;
}

function readHeight(): number | null {
  if (typeof window === "undefined") return null;
  const vv = window.visualViewport;
  if (!vv || !Number.isFinite(vv.height) || vv.height <= 0) return null;
  return vv.height;
}

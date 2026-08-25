/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ホイール／トラックパッドのスクロール → スライス送り量を求める純関数（`SeriesViewer` が使う）。
 *
 * <p>🔴 **1 ノッチ = 1 スライス**。以前は `wheel` イベントごとに 1 スライス送っていたが、
 * 高分解能ホイールとトラックパッドは 1 回の操作で何十件もイベントを出すため、
 * 少し回しただけで一気に飛んでいた（2026-08-25 の指摘）。ここで
 * 「離散のノッチ」と「細かい連続 delta」を区別し、**返す値は必ず −1 / 0 / +1** にする。
 *
 * <p>⚠️ ブラウザごとに単位が違う。Chrome/Edge は 1 ノッチで `deltaMode=0, deltaY=100`
 * （環境により 120 や 53）、Firefox は `deltaMode=1, deltaY=3`（行単位）。
 * 「px を一定量ためて割る」方式にすると、割り切れない環境で数ノッチに 1 回だけ 2 スライス
 * 飛ぶ。そこで**離散イベントは大きさに関係なく 1 ノッチとして扱う**。
 */

/** 1 イベントの縦移動量がこれ以上なら「マウスホイールの離散ノッチ」とみなす [px]。 */
export const WHEEL_DISCRETE_PX = 40;

/** トラックパッド等の細かい delta を積んで 1 スライス送るのに要る量 [px]。 */
export const WHEEL_FINE_PX = 40;

/** これを超えて間が空いたら、ためた端数を捨てる [ms]（惰性スクロールの続きで動かさない）。 */
export const WHEEL_IDLE_MS = 250;

/** {@link createWheelStepper} の戻り値。**−1 / 0 / +1 しか返さない**。 */
export type WheelStepper = (deltaY: number, deltaMode: number, timeStamp: number) => -1 | 0 | 1;

export interface WheelStepperOptions {
  discretePx?: number;
  finePx?: number;
  idleMs?: number;
}

/**
 * ホイール入力を「1 スライスずつの送り」に変換する状態つき関数を作る。
 *
 * <p>状態（ためた端数・向き・最後の時刻）を閉じ込めるので、**ビューポートごとに 1 つ**作る。
 */
export function createWheelStepper(opts: WheelStepperOptions = {}): WheelStepper {
  const discretePx = opts.discretePx ?? WHEEL_DISCRETE_PX;
  const finePx = opts.finePx ?? WHEEL_FINE_PX;
  const idleMs = opts.idleMs ?? WHEEL_IDLE_MS;

  let acc = 0;
  let dir = 0;
  let last = Number.NEGATIVE_INFINITY;

  return (deltaY, deltaMode, timeStamp) => {
    if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
    const sign = deltaY > 0 ? 1 : -1;
    const ts = Number.isFinite(timeStamp) ? timeStamp : 0;

    // 間が空いた／向きが変わったら端数を捨てる。残すと、戻し始めた 1 回目が
    // 直前の逆向きの端数で相殺され、「1 回空振りする」挙動になる。
    if (ts - last > idleMs || sign !== dir) acc = 0;
    last = ts;
    dir = sign;

    // 行/ページ単位（Firefox 等）と、大きな px 値は「離散ノッチ」＝ 1 イベント 1 スライス。
    if (deltaMode !== 0 || Math.abs(deltaY) >= discretePx) {
      acc = 0;
      return sign;
    }

    // 細かい連続 delta（トラックパッド・高分解能ホイール）は貯めてから 1 スライス。
    acc += deltaY;
    if (Math.abs(acc) < finePx) return 0;
    acc -= sign * finePx;
    return sign;
  };
}

/**
 * Cornerstone の `StackScrollTool`（ホイール割り当て）に **1 ノッチ = 1 スライス**を効かせる。
 *
 * <p>Cornerstone は `wheel` イベント 1 件につき必ず 1 スライス送る
 * （`wheelListener` が `direction = ±1` を作り、`StackScrollTool._scroll` が
 * `delta = direction` で送る。**`deltaY` の大きさは見ていない**）。そのため高分解能ホイールや
 * トラックパッドのように 1 回の操作で何十件もイベントが出る入力では、一気に飛ぶ。
 *
 * <p>ツール側に刻みの設定は無いので、**要素の capture 段でホイールを間引く**。
 * ノッチに達しないイベントはそこで止め（`stopImmediatePropagation`）、
 * 達したものだけ Cornerstone のリスナーへ通す。通ったイベントは 1 スライスちょうど送られる。
 *
 * <p>⚠️ **ホイールがスライス送り以外に割り当たっている面には付けない。**
 * プラグインの 3D 面はホイールが Zoom なので、間引くと拡大縮小が粗くなる。
 *
 * <p>⚠️ capture 段に置くのは Cornerstone のリスナーより先に受けるため。Cornerstone は
 * `enableElement` された要素に bubble で付けており、実際のイベント標的はその中の canvas
 * （子孫）なので、この要素の capture は必ず先に走る。
 *
 * <p>同じ要素に二重には付かない（`dataset` で印を付ける）。要素が捨てられればリスナーも
 * 一緒に消えるので、明示的な後始末は要らない。
 */
export function installWheelSliceGate(el: HTMLElement | null | undefined, opts: WheelStepperOptions = {}): void {
  if (!el || el.dataset.graphyWheelGate === "1") return;
  el.dataset.graphyWheelGate = "1";
  const stepper = createWheelStepper(opts);
  el.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if (stepper(e.deltaY, e.deltaMode, e.timeStamp) !== 0) return; // ノッチ到達 → 通す
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    { capture: true, passive: false },
  );
}

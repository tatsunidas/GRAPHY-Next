/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * シネ再生コントロール（`fw/angio-design.md` §5.6）。
 *
 * <p>XA/XRF のように「実時間で再生する」意味がある軸（{@code kind:"frame"}）に対して、
 * 再生/停止・ループ・速度（0.25〜2.0x）・コマ送り・実時間表示を提供する。
 * 汎用の {@code DimSlider} の再生ボタン（等間隔タイマ）とは別物なので、
 * <b>フレーム軸ではこちらに差し替える</b>（再生ボタンが 2 つ並ぶのを避ける）。
 *
 * <p>再生は **経過時刻 → フレーム番号**（{@link frameAtElapsed}）で駆動する。こうすると
 * FrameTimeVector による可変間隔（可変レート DSA）も等間隔も同じコードで扱え、
 * 描画が間に合わないときも「時間軸が伸びる」のではなく**フレームを飛ばして実時間を保つ**。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { reportXaCineStats } from "./debugApi";
import {
  cineDurationMs,
  frameAtElapsed,
  frameStartTimesMs,
  resolveXaFps,
  XA_PLAYBACK_RATES,
  type XaCineSource,
} from "./xaCine";

export interface CineControlsProps {
  /** フレーム総数。 */
  count: number;
  /** 現在フレーム（0 origin）。 */
  index: number;
  onIndex: (i: number) => void;
  /** fps 決定の材料（DICOM タグ由来）。null なら既定 fps。 */
  source?: XaCineSource | null;
  /** 外側でスライダーを描くか（false なら再生/速度/コマ送りだけ）。 */
  showSeek?: boolean;
}

/** 秒を m:ss.s 表記に。 */
function fmtSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0.0s";
  return `${sec.toFixed(1)}s`;
}

export default function CineControls({
  count,
  index,
  onIndex,
  source,
  showSeek = true,
}: CineControlsProps): React.ReactElement {
  const { t } = useI18n();
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [rate, setRate] = useState(1.0);

  const effectiveSource: XaCineSource = useMemo(
    () => source ?? { numberOfFrames: Math.max(1, count) },
    [source, count],
  );
  const times = useMemo(() => frameStartTimesMs(effectiveSource), [effectiveSource]);
  const totalMs = useMemo(() => cineDurationMs(effectiveSource), [effectiveSource]);
  const { fps, source: fpsSource } = useMemo(() => resolveXaFps(effectiveSource), [effectiveSource]);

  // rAF ループ用（state を読むと再購読が要るので ref に置く）。
  const indexRef = useRef(index);
  indexRef.current = index;
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const loopRef = useRef(loop);
  loopRef.current = loop;
  const onIndexRef = useRef(onIndex);
  onIndexRef.current = onIndex;

  const stop = useCallback(() => setPlaying(false), []);

  // 総フレーム数や時間軸が変わったら停止（別ランへ切り替えた時に走り続けない）。
  useEffect(() => {
    setPlaying(false);
  }, [count, totalMs]);

  useEffect(() => {
    if (!playing || count <= 1) return;
    let raf = 0;
    // 再生開始時のフレームの時刻を起点にする（途中から再生しても飛ばない）。
    const startElapsed = times[Math.min(Math.max(0, indexRef.current), times.length - 1)] ?? 0;
    const startTs = performance.now();
    let renderedFrames = 0;
    let fpsWindowStart = startTs;
    let fpsWindowFrames = 0;
    let lastIndex = indexRef.current;

    const tick = () => {
      const now = performance.now();
      const elapsed = startElapsed + (now - startTs) * rateRef.current;
      const next = frameAtElapsed(times, totalMs, elapsed, loopRef.current);
      if (next !== lastIndex) {
        lastIndex = next;
        renderedFrames += 1;
        fpsWindowFrames += 1;
        onIndexRef.current(next);
      }
      // 1 秒ごとに実測 fps を更新（automator が数値で合否判定できるようにする）。
      if (now - fpsWindowStart >= 1000) {
        reportXaCineStats({
          measuredFps: (fpsWindowFrames * 1000) / (now - fpsWindowStart),
          nominalFps: fps,
          fpsSource,
          framesRendered: renderedFrames,
        });
        fpsWindowStart = now;
        fpsWindowFrames = 0;
      }
      // ループしない場合、最終フレームに達したら止める。
      if (!loopRef.current && next >= times.length - 1) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, count, times, totalMs, fps, fpsSource]);

  const step = useCallback(
    (delta: number) => {
      setPlaying(false);
      const n = Math.max(1, count);
      const next = (((indexRef.current + delta) % n) + n) % n;
      onIndexRef.current(next);
    },
    [count],
  );

  const curSec = (times[Math.min(index, times.length - 1)] ?? 0) / 1000;
  const totSec = totalMs / 1000;
  const disabled = count <= 1;

  return (
    <>
      <div style={row}>
        <button
          type="button"
          style={btn}
          data-testid="cine-play"
          disabled={disabled}
          onClick={() => setPlaying((p) => !p)}
          title={t(playing ? "cine.pause" : "cine.play")}
        >
          {playing ? "⏸" : "▶"}
        </button>
        {showSeek && (
          <input
            type="range"
            data-testid="cine-seek"
            min={0}
            max={Math.max(0, count - 1)}
            step={1}
            value={Math.min(index, Math.max(0, count - 1))}
            disabled={disabled}
            onChange={(e) => {
              stop();
              onIndex(Number(e.target.value));
            }}
            style={{ flex: 1, minWidth: 100 }}
          />
        )}
        <span style={counter} data-testid="cine-indicator">
          {index + 1}/{count}
        </span>
      </div>
      <div style={row}>
        <button type="button" style={btn} disabled={disabled} onClick={() => step(-1)} title={t("cine.prevFrame")}>
          ◀|
        </button>
        <button type="button" style={btn} disabled={disabled} onClick={() => step(1)} title={t("cine.nextFrame")}>
          |▶
        </button>
        <label style={label}>
          <input type="checkbox" checked={loop} disabled={disabled} onChange={(e) => setLoop(e.target.checked)} />
          {t("cine.loop")}
        </label>
        <label style={label}>
          {t("cine.speed")}
          <select
            value={rate}
            disabled={disabled}
            onChange={(e) => setRate(Number(e.target.value))}
            style={selectBox}
            data-testid="cine-speed"
          >
            {XA_PLAYBACK_RATES.map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
        </label>
        {/* fps は automator が「動画の尺が画面と合っているか」を突き合わせる根拠になる。 */}
        <span style={hint} data-testid="cine-fps" title={t(`cine.fpsSource.${fpsSource}`)}>
          {t("cine.fps", { fps: fps.toFixed(1) })} · {fmtSec(curSec)}/{fmtSec(totSec)}
        </span>
      </div>
    </>
  );
}

const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10 };
const btn: React.CSSProperties = {
  padding: "2px 8px",
  background: "#1b2733",
  color: "#dfe7ee",
  border: "1px solid #2b3a4a",
  borderRadius: 4,
  cursor: "pointer",
};
const selectBox: React.CSSProperties = {
  background: "#1b2733",
  color: "#dfe7ee",
  border: "1px solid #2b3a4a",
  borderRadius: 4,
  padding: "1px 4px",
};
const label: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  fontSize: 12,
  color: "#c3ced9",
};
const counter: React.CSSProperties = {
  fontSize: 12,
  color: "#c3ced9",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
};
const hint: React.CSSProperties = { fontSize: 12, color: "#9aa6b2", whiteSpace: "nowrap" };

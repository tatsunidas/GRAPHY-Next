/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * メイン画面の下部に固定するシリーズプレビューの枠（ドック）。
 *
 * <p>一覧が長くてもスクロールせずに画像が見えるよう、スクロール領域の外に置く。
 * 表示/非表示の切替と、上端のハンドルによる高さの変更ができ、どちらも保存する。
 * 中身（SeriesViewer）は `StudyList` が portal でこの枠の本体へ描く。閉じているときは本体を持たない
 * ので、プレビューは読み込まれない。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { clampDockHeight, DOCK_DEFAULT_RATIO, DOCK_STORAGE_KEY, parseDockState } from "./dockSize";

function readStored() {
  try {
    return parseDockState(window.localStorage.getItem(DOCK_STORAGE_KEY));
  } catch {
    return parseDockState(null);
  }
}

export function PreviewDock({ onHost }: { onHost: (el: HTMLElement | null) => void }) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState(readStored);
  const [containerH, setContainerH] = useState(() => window.innerHeight);

  // 領域の高さ（親の列）に追従する。窓を小さくしたときもドックが一覧を潰さない。
  useEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    const update = () => setContainerH(parent.clientHeight || window.innerHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  // 安定した ref（毎回 null→要素 と呼ばれて親の state を揺らさない）。
  const hostRef = useCallback((el: HTMLDivElement | null) => onHost(el), [onHost]);

  const height = clampDockHeight(state.height ?? containerH * DOCK_DEFAULT_RATIO, containerH);

  const save = useCallback((next: { open: boolean; height: number | null }) => {
    setState(next);
    try {
      window.localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* 保存できなくても動く */
    }
  }, []);

  const onHandleDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent) => {
      setState((s) => ({ ...s, height: clampDockHeight(startH + (startY - ev.clientY), containerH) }));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      save({ open: true, height: clampDockHeight(startH + (startY - ev.clientY), containerH) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={rootRef} data-testid="preview-dock" style={{ flex: "none", borderTop: "1px solid #cdd5de", background: "#fff" }}>
      {state.open && (
        <div
          data-testid="preview-dock-handle"
          role="separator"
          aria-orientation="horizontal"
          title={t("main.dock.resize")}
          onPointerDown={onHandleDown}
          style={{ height: 6, cursor: "row-resize", background: "#e6eaee" }}
        />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 12px", fontSize: 12, background: "#f7f9fb" }}>
        <button
          type="button"
          data-testid="preview-dock-toggle"
          aria-expanded={state.open}
          onClick={() => save({ open: !state.open, height: state.height })}
        >
          {state.open ? "▾" : "▸"} {t(state.open ? "main.dock.hide" : "main.dock.show")}
        </button>
        {state.open && <span style={{ color: "#6b7785" }}>{t("main.dock.hint")}</span>}
      </div>
      {state.open && (
        <div
          ref={hostRef}
          data-testid="preview-dock-body"
          style={{ height, display: "flex", flexDirection: "column", minHeight: 0, padding: "0 12px 8px" }}
        />
      )}
    </div>
  );
}

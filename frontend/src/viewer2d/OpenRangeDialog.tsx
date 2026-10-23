/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 「範囲を指定して開く」ダイアログ。シリーズの一部（連続した 1 区間）だけをタイルとして開く。
 * DB・ファイルは変えない。入力の判定は {@link resolveOpenRange}（純関数）。
 */
import { useEffect, useMemo, useState } from "react";
import { fetchSeriesLayout } from "../api";
import { useI18n } from "../i18n/i18n";
import { buildLayoutFromDto, type SeriesLayout } from "../viewer/seriesLayout";
import type { ViewerMode } from "../viewer/imageId";
import { positionsMm, type ZRange } from "../viewer/virtualLayout";
import { resolveOpenRange } from "./openRangeInput";

export function OpenRangeDialog({
  mode, studyUid, seriesUid, title, initial, onOpen, onClose,
}: {
  mode: ViewerMode;
  studyUid: string;
  seriesUid: string;
  title: string;
  /** 既存の範囲（範囲を変えるとき）。 */
  initial?: ZRange;
  onOpen: (range: ZRange) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [layout, setLayout] = useState<SeriesLayout | null>(null);
  const [failed, setFailed] = useState(false);
  const [method, setMethod] = useState<"index" | "mm">("index");
  const [text, setText] = useState("");
  const [fromMm, setFromMm] = useState("");
  const [toMm, setToMm] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchSeriesLayout(studyUid, seriesUid)
      .then((dto) => {
        if (cancelled) return;
        // SeriesViewer と同じ経路。取れなければ範囲は決められないので、全体を暗黙に開かず失敗として出す。
        const built = buildLayoutFromDto(dto, mode, studyUid, seriesUid);
        if (built) setLayout(built);
        else setFailed(true);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [studyUid, seriesUid, mode]);

  const pos = useMemo(() => (layout ? positionsMm(layout) : null), [layout]);
  useEffect(() => {
    if (!pos) { setMethod("index"); return; }
    if (initial?.kind === "mm") {
      setMethod("mm");
      setFromMm(String(initial.fromMm));
      setToMm(String(initial.toMm));
    }
  }, [pos, initial]);

  const result = useMemo(() => {
    if (!layout) return null;
    return resolveOpenRange(layout, method === "index" ? { method, text } : { method, fromMm, toMm });
  }, [layout, method, text, fromMm, toMm]);

  const touched = method === "index" ? text.trim() !== "" : fromMm.trim() !== "" || toMm.trim() !== "";
  const minMm = pos ? Math.min(...pos) : 0;
  const maxMm = pos ? Math.max(...pos) : 0;

  return (
    <div style={backdrop} data-testid="open-range-dialog" onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("openRange.title")}</div>
        <div style={{ fontSize: 12, marginBottom: 8 }}>{title}</div>
        {failed && <div style={err}>{t("openRange.layoutFailed")}</div>}
        {!layout && !failed && <div>{t("common.loading")}</div>}
        {layout && (
          <>
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              {t("openRange.summary", { count: layout.nZ })}
              {pos && ` / ${t("openRange.position", { from: minMm.toFixed(1), to: maxMm.toFixed(1) })}`}
            </div>
            <div style={{ display: "flex", gap: 12, marginBottom: 6, fontSize: 12 }}>
              <label><input type="radio" checked={method === "index"} onChange={() => setMethod("index")} /> {t("openRange.byIndex")}</label>
              <label style={{ opacity: pos ? 1 : 0.5 }}>
                <input type="radio" disabled={!pos} checked={method === "mm"} onChange={() => setMethod("mm")} /> {t("openRange.byMm")}
              </label>
            </div>
            {method === "index" ? (
              <input
                data-testid="open-range-index" style={{ width: "100%" }} value={text}
                placeholder="101-200" onChange={(e) => setText(e.target.value)}
              />
            ) : (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input data-testid="open-range-from" style={{ width: 90 }} value={fromMm} onChange={(e) => setFromMm(e.target.value)} />
                〜
                <input data-testid="open-range-to" style={{ width: 90 }} value={toMm} onChange={(e) => setToMm(e.target.value)} />
                mm
              </div>
            )}
            {!pos && <div style={{ fontSize: 11, color: "#6b7785", marginTop: 4 }}>{t("openRange.noIpp")}</div>}
            <div style={{ minHeight: 20, marginTop: 6, fontSize: 12 }} data-testid="open-range-status">
              {touched && result && (result.ok
                ? t("openRange.willOpen", { count: result.count })
                : <span style={{ color: "#b3261e" }}>{t(`openRange.fail.${result.reason}`)}{result.ok === false && result.detail ? `: ${result.detail}` : ""}</span>)}
            </div>
          </>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
          <button type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button
            type="button" data-testid="open-range-confirm"
            disabled={!result || !result.ok}
            onClick={() => result && result.ok && onOpen(result.range)}
          >{t("openRange.open")}</button>
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000,
  display: "flex", alignItems: "center", justifyContent: "center",
};
const box: React.CSSProperties = {
  background: "#fff", color: "#1a1a1a", borderRadius: 8, padding: 16, width: 380,
  boxShadow: "0 8px 30px rgba(0,0,0,0.3)", fontFamily: "system-ui, sans-serif",
};
const err: React.CSSProperties = { color: "#b3261e", fontSize: 12 };

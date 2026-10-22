/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 解析 ▸ 最大断面へ移動…: 保存済みの SEG とセグメントを選び、その ROI の最大断面のスライスへ表示を移す。
 * 求め方は ROI 特徴量の画面と同じ API（特徴量の計算に使うマスクと同じもの）。
 */
import { useEffect, useState } from "react";
import {
  fetchMaxSection,
  fetchSeries,
  fetchSeriesLayout,
  readDicomSegSegments,
  type Series,
} from "../api";
import { useI18n } from "../i18n/i18n";
import { formatAreaMm2, formatPositionMm } from "../radiomics/maxSection";
import { emitRoiReveal } from "../viewer/roiReveal";
import { isSliceNavigationLocked } from "../viewer/sliceNavigationLock";
import { emitToast } from "../viewer/toast";

interface Props {
  studyUid: string;
  /** 移動の対象（表示中のシリーズ）。 */
  seriesUid: string;
  onClose: () => void;
}

export function MaxSectionDialog({ studyUid, seriesUid, onClose }: Props) {
  const { t } = useI18n();
  const [segs, setSegs] = useState<Series[]>([]);
  const [maskUid, setMaskUid] = useState("");
  const [segNames, setSegNames] = useState<string[]>([]);
  const [channel, setChannel] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchSeries(studyUid)
      .then((list) => {
        const found = list.filter((s) => s.modality === "SEG");
        setSegs(found);
        if (found.length === 1) setMaskUid(found[0].seriesInstanceUid);
      })
      .catch((e: unknown) => setMsg(t("common.fetchError", { error: String(e) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyUid]);

  useEffect(() => {
    let cancelled = false;
    setChannel(0);
    setSegNames([]);
    if (!maskUid) return;
    void fetchSeriesLayout(studyUid, maskUid)
      .then((layout) => {
        if (cancelled || layout.nC <= 1) return;
        return readDicomSegSegments(studyUid, maskUid).then((seg) => {
          if (!cancelled && seg.segments.length === layout.nC) {
            setSegNames(seg.segments.map((s) => s.label || s.description || ""));
          } else if (!cancelled) {
            setSegNames(Array.from({ length: layout.nC }, () => ""));
          }
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [studyUid, maskUid]);

  const go = async () => {
    setMsg(null);
    if (isSliceNavigationLocked()) {
      setMsg(t("roiFeat.maxSection.locked"));
      return;
    }
    setBusy(true);
    try {
      const r = await fetchMaxSection({
        studyInstanceUid: studyUid, sourceSeriesUid: seriesUid, maskSeriesUid: maskUid,
        maskChannel: channel, channel: 0, timePoint: 0, label: 1,
      });
      emitRoiReveal({
        sopInstanceUid: r.best.sopInstanceUid,
        frame: r.best.frame >= 0 ? r.best.frame : null,
        seriesUid,
      });
      emitToast(t("roiFeat.maxSection.toast", {
        pos: formatPositionMm(r.best.positionMm), area: formatAreaMm2(r.best.areaMm2),
      }));
      onClose();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={backdrop} data-testid="maxsection-dialog">
      <div style={card}>
        <div style={title}>{t("roiFeat.maxSection.menu")}</div>
        {segs.length === 0 ? (
          <div style={note} data-testid="maxsection-nosegs">{t("roiFeat.maxSection.noSeg")}</div>
        ) : (
          <>
            <label style={row}>
              <span style={lab}>{t("roiFeat.field.mask")}</span>
              <select value={maskUid} onChange={(e) => setMaskUid(e.target.value)} style={input} data-testid="maxsection-mask">
                <option value="">{t("roiFeat.mask.none")}</option>
                {segs.map((s) => (
                  <option key={s.seriesInstanceUid} value={s.seriesInstanceUid}>
                    {`#${s.seriesNumber ?? "?"} ${s.seriesDescription ?? ""}`.trim()}
                  </option>
                ))}
              </select>
            </label>
            {segNames.length > 1 && (
              <label style={row}>
                <span style={lab}>{t("texture.field.maskChannel")}</span>
                <select value={channel} onChange={(e) => setChannel(Number(e.target.value))} style={input} data-testid="maxsection-seg">
                  {segNames.map((n, i) => <option key={i} value={i}>{n ? `${i}: ${n}` : String(i)}</option>)}
                </select>
              </label>
            )}
          </>
        )}
        {msg && <div style={err} data-testid="maxsection-error">{msg}</div>}
        <div style={buttons}>
          <button type="button" style={btn} onClick={onClose}>{t("common.close")}</button>
          <button type="button" style={primary} disabled={!maskUid || busy} onClick={() => void go()} data-testid="maxsection-go">
            {t("roiFeat.maxSection.go")}
          </button>
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3000,
};
const card: React.CSSProperties = {
  width: 460, maxWidth: "92vw", background: "#fff", borderRadius: 10,
  boxShadow: "0 10px 40px rgba(0,0,0,0.3)", padding: 16, fontSize: 13, color: "#222",
};
const title: React.CSSProperties = { fontSize: 15, fontWeight: 600, marginBottom: 12 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 };
const lab: React.CSSProperties = { width: 130, flexShrink: 0 };
const input: React.CSSProperties = { flex: 1, padding: "3px 6px" };
const note: React.CSSProperties = { color: "#6b7785", fontSize: 12, lineHeight: 1.5 };
const err: React.CSSProperties = { color: "#b00020", marginTop: 6, whiteSpace: "pre-wrap" };
const buttons: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 };
const btn: React.CSSProperties = { background: "#fff", border: "1px solid #c3ccd6", borderRadius: 4, padding: "4px 12px" };
const primary: React.CSSProperties = { background: "#1a5fb4", color: "#fff", border: "1px solid #1a5fb4", borderRadius: 4, padding: "4px 12px" };

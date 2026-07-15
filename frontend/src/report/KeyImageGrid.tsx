/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useState } from "react";
import { fetchInstances, type Instance, type ReportKeyImageInput, type Series } from "../api";
import { useI18n } from "../i18n/i18n";
import { KeyImageThumb } from "./KeyImageThumb";
import type { ViewerMode } from "../viewer/imageId";

/**
 * レポートのキー画像グリッド。MainScreen で選択中のシリーズからインスタンスを選んで追加する
 * （表示中画像からの直接追加はビューア連携が必要なため将来対応、`fw/report-design.md` §9）。
 */
export function KeyImageGrid({
  keyImages,
  onChange,
  selectedSeries,
  studyUid,
  mode,
  readOnly,
}: {
  keyImages: ReportKeyImageInput[];
  onChange: (next: ReportKeyImageInput[]) => void;
  selectedSeries: Series | null;
  studyUid: string | null;
  mode: ViewerMode;
  readOnly?: boolean;
}) {
  const { t } = useI18n();
  const [instances, setInstances] = useState<Instance[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openPicker = async () => {
    if (!studyUid || !selectedSeries) return;
    setError(null);
    setInstances(null);
    setPickerOpen(true);
    try {
      const insts = await fetchInstances(studyUid, selectedSeries.seriesInstanceUid);
      setInstances(insts);
    } catch (e) {
      setError(String(e));
    }
  };

  const addInstance = (inst: Instance) => {
    if (!selectedSeries) return;
    const next: ReportKeyImageInput = {
      sopInstanceUid: inst.sopInstanceUid,
      seriesInstanceUid: selectedSeries.seriesInstanceUid,
      frameNumber: null,
      label: t("report.keyImages.instance", { number: inst.instanceNumber ?? "?" }),
      annotation: "",
      sortOrder: keyImages.length,
    };
    onChange([...keyImages, next]);
    setPickerOpen(false);
  };

  const update = (i: number, patch: Partial<ReportKeyImageInput>) => {
    const next = keyImages.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const remove = (i: number) =>
    onChange(keyImages.filter((_, idx) => idx !== i).map((k, idx) => ({ ...k, sortOrder: idx })));

  return (
    <div>
      <div style={sectionHeader}>
        <span style={{ fontWeight: 700 }}>{t("report.keyImages.title")}</span>
        {!readOnly && (
          <button
            type="button"
            style={smallBtn}
            disabled={!selectedSeries}
            title={!selectedSeries ? t("report.keyImages.noSeriesSelected") : undefined}
            onClick={() => void openPicker()}
          >
            {t("report.keyImages.addFromSeries")}
          </button>
        )}
      </div>
      {keyImages.length === 0 && <div style={emptyMsg}>{t("report.keyImages.empty")}</div>}
      <div style={grid}>
        {keyImages.map((k, i) => (
          <div key={`${k.sopInstanceUid}-${i}`} style={card}>
            {studyUid && (
              <KeyImageThumb
                mode={mode}
                studyUid={studyUid}
                seriesUid={k.seriesInstanceUid}
                sopUid={k.sopInstanceUid}
                frameNumber={k.frameNumber}
                width={164}
                height={123}
              />
            )}
            <input
              style={inputSm}
              placeholder={t("report.keyImages.label")}
              value={k.label ?? ""}
              disabled={readOnly}
              onChange={(e) => update(i, { label: e.target.value })}
            />
            <input
              style={inputSm}
              placeholder={t("report.keyImages.annotation")}
              value={k.annotation ?? ""}
              disabled={readOnly}
              onChange={(e) => update(i, { annotation: e.target.value })}
            />
            {!readOnly && (
              <button type="button" style={removeBtn} onClick={() => remove(i)}>
                {t("report.keyImages.remove")}
              </button>
            )}
          </div>
        ))}
      </div>

      {pickerOpen && (
        <div style={overlay} onClick={() => setPickerOpen(false)}>
          <div style={pickerDialog} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>{t("report.keyImages.pickInstance")}</div>
            {error && <div style={{ color: "#b00020" }}>{error}</div>}
            {!error && !instances && <div>{t("common.loading")}</div>}
            <div style={{ maxHeight: 300, overflow: "auto" }}>
              {instances?.map((inst) => (
                <div key={inst.sopInstanceUid} style={pickRow} onClick={() => addInstance(inst)}>
                  {studyUid && selectedSeries && (
                    <KeyImageThumb
                      mode={mode}
                      studyUid={studyUid}
                      seriesUid={selectedSeries.seriesInstanceUid}
                      sopUid={inst.sopInstanceUid}
                      frameNumber={null}
                      width={60}
                      height={45}
                    />
                  )}
                  <span>{t("report.keyImages.instance", { number: inst.instanceNumber ?? "?" })}</span>
                </div>
              ))}
            </div>
            <div style={{ textAlign: "right", marginTop: 8 }}>
              <button type="button" style={smallBtn} onClick={() => setPickerOpen(false)}>
                {t("common.close")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const sectionHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 6,
};
const emptyMsg: React.CSSProperties = { color: "#888", fontSize: 12, padding: "4px 0" };
const grid: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8 };
const card: React.CSSProperties = {
  width: 180,
  border: "1px solid #e2e7ec",
  borderRadius: 6,
  padding: 8,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  background: "#fafbfc",
};
const inputSm: React.CSSProperties = {
  padding: "4px 6px",
  border: "1px solid #d7dde3",
  borderRadius: 5,
  fontSize: 12,
};
const smallBtn: React.CSSProperties = {
  padding: "3px 10px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 12,
};
const removeBtn: React.CSSProperties = {
  padding: "3px 8px",
  border: "1px solid #e0b4b4",
  color: "#a02525",
  borderRadius: 5,
  background: "#fff",
  cursor: "pointer",
  fontSize: 11,
};
const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1100,
};
const pickerDialog: React.CSSProperties = {
  width: 360,
  maxWidth: "90vw",
  background: "#fff",
  borderRadius: 8,
  boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
  padding: 14,
  fontFamily: "system-ui, sans-serif",
  color: "#1a1a1a",
};
const pickRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 13,
};

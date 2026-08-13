/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * GLAM 解析（別ウィンドウ `#glam`）。
 *
 * <p>可視化マップとは別の見方をする画面。マップは窓ごとに GLAM を回すので窓の外が見えず、
 * カーネル 7 なら r=1..3 しか観測できない。ここは ROI 全体を 1 つの領域として 1 回だけ回すので
 * カーネルが無く、maxRadius を 30〜50 まで取れる。「この組織は何ボクセルで自己相関を失うか」は
 * こちらでしか読めない。両者は競合ではなく補完。
 *
 * <p>保存は任意。ROI が同じなら何度でも同じ数値が出るので、残すかどうかは利用者が決める。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/i18n";
import {
  analyzeGlam,
  deleteGlamAnalysis,
  fetchSeries,
  listGlamAnalyses,
  loadGlamAnalysis,
  saveGlamAnalysis,
  type GlamAnalysis,
  type GlamSavedSummary,
  type Series,
} from "../api";
import { fetchSettings } from "../settings/settingsApi";
import { GLAM_MATRICES } from "../viewer/textureFeatures";
import { BinOccupancyChart, MatrixHeatmap, SelfAffinityChart, binColor } from "./GlamCharts";

/** 2D ビューアから渡される対象（localStorage 経由。ウィンドウを跨ぐため）。 */
interface GlamContext {
  studyInstanceUid: string;
  seriesInstanceUid?: string;
}

export const GLAM_CTX_KEY = "graphy-glam-ctx";

export function GlamAnalysisScreen() {
  const { t } = useI18n();

  const ctx = useMemo<GlamContext | null>(() => {
    try {
      const raw = localStorage.getItem(GLAM_CTX_KEY);
      return raw ? (JSON.parse(raw) as GlamContext) : null;
    } catch {
      return null;
    }
  }, []);

  const [allSeries, setAllSeries] = useState<Series[]>([]);
  const [sourceSeriesUid, setSourceSeriesUid] = useState(ctx?.seriesInstanceUid ?? "");
  const [maskSeriesUid, setMaskSeriesUid] = useState("");
  const [maxRadius, setMaxRadius] = useState(30);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [analysis, setAnalysis] = useState<GlamAnalysis | null>(null);
  const [matrixName, setMatrixName] = useState("SecondVirialCoefficient");
  const [saved, setSaved] = useState<GlamSavedSummary[]>([]);
  const [saveLabel, setSaveLabel] = useState("");

  const studyUid = ctx?.studyInstanceUid ?? "";

  const refreshSaved = useCallback(() => {
    if (!studyUid) return;
    void listGlamAnalyses(studyUid).then(setSaved).catch(() => {});
  }, [studyUid]);

  useEffect(() => {
    if (!studyUid) return;
    void fetchSeries(studyUid)
      .then((list) => {
        setAllSeries(list);
        if (!sourceSeriesUid && list.length) setSourceSeriesUid(list[0].seriesInstanceUid);
      })
      .catch((e: unknown) => setError(String(e)));
    void fetchSettings()
      .then((raw) => {
        const s: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (k.startsWith("texture.")) s[k.slice("texture.".length)] = v;
        }
        setSettings(s);
      })
      .catch(() => {});
    refreshSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyUid]);

  const maskCandidates = useMemo(
    () => allSeries.filter((s) => s.seriesInstanceUid !== sourceSeriesUid),
    [allSeries, sourceSeriesUid],
  );

  const onRun = async () => {
    setError(null);
    if (!maskSeriesUid) return setError(t("glam.err.needMask"));
    setBusy(true);
    try {
      const result = await analyzeGlam({
        studyInstanceUid: studyUid,
        sourceSeriesUid,
        maskSeriesUid,
        maskChannel: 0,
        channel: 0,
        timePoint: 0,
        maxRadius,
        settings,
      });
      setAnalysis(result);
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    if (!analysis) return;
    setError(null);
    try {
      await saveGlamAnalysis({
        studyInstanceUid: studyUid,
        sourceSeriesUid,
        maskSeriesUid,
        label: saveLabel.trim() || `GLAM ${new Date().toLocaleString()}`,
        analysis,
      });
      setSaveLabel("");
      refreshSaved();
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    }
  };

  const onLoad = async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      setAnalysis(await loadGlamAnalysis(id));
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string) => {
    try {
      await deleteGlamAnalysis(id);
      refreshSaved();
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    }
  };

  const seriesLabel = (s: Series) =>
    `#${s.seriesNumber ?? "?"} ${s.modality ?? ""} ${s.seriesDescription ?? ""}`.trim();

  const matrixMeta = GLAM_MATRICES.find((m) => m.name === matrixName);
  const matrix = analysis?.matrices?.[matrixName];

  return (
    <div style={page}>
      <div style={header}>{t("glam.title")}</div>

      {!studyUid && <div style={errText}>{t("glam.err.noContext")}</div>}

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* ── 設定 ── */}
        <div style={panel}>
          <Field label={t("glam.field.target")}>
            <select value={sourceSeriesUid} onChange={(e) => setSourceSeriesUid(e.target.value)}
              disabled={busy} style={input}>
              {allSeries.map((s) => (
                <option key={s.seriesInstanceUid} value={s.seriesInstanceUid}>{seriesLabel(s)}</option>
              ))}
            </select>
          </Field>
          <Field label={t("glam.field.mask")}>
            <select value={maskSeriesUid} onChange={(e) => setMaskSeriesUid(e.target.value)}
              disabled={busy} style={input}>
              <option value="">{t("glam.mask.none")}</option>
              {maskCandidates.map((s) => (
                <option key={s.seriesInstanceUid} value={s.seriesInstanceUid}>{seriesLabel(s)}</option>
              ))}
            </select>
          </Field>
          <Field label={t("glam.field.maxRadius")}>
            <input type="number" min={2} max={200} value={maxRadius}
              onChange={(e) => setMaxRadius(Number(e.target.value))} disabled={busy} style={input} />
          </Field>
          <div style={note}>{t("glam.note")}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 10, justifyContent: "flex-end" }}>
            <button onClick={onRun} disabled={busy || !studyUid} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>
              {busy ? t("glam.running") : t("glam.run")}
            </button>
          </div>
          {error && <div style={errText}>{error}</div>}
        </div>

        {/* ── 保存 ── */}
        <div style={panel}>
          <div style={sectionTitle}>{t("glam.saved.title")}</div>
          <div style={note}>{t("glam.saved.note")}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <input value={saveLabel} onChange={(e) => setSaveLabel(e.target.value)}
              placeholder={t("glam.saved.labelPlaceholder")} disabled={!analysis} style={{ ...input, flex: 1 }} />
            <button onClick={onSave} disabled={!analysis} style={btn}>{t("glam.saved.save")}</button>
          </div>
          {saved.length === 0 ? (
            <div style={{ ...note, marginTop: 8 }}>{t("glam.saved.empty")}</div>
          ) : (
            <table style={{ width: "100%", marginTop: 8, fontSize: 11, borderCollapse: "collapse" }}>
              <tbody>
                {saved.map((s) => (
                  <tr key={s.id} style={{ borderTop: "1px solid #eef2f6" }}>
                    <td style={{ padding: "3px 4px" }}>{s.label}</td>
                    <td style={{ padding: "3px 4px", color: "#6b7785", whiteSpace: "nowrap" }}>
                      {t("glam.saved.meta", { bins: s.nBins, radius: s.maxRadius })}
                    </td>
                    <td style={{ padding: "3px 4px", whiteSpace: "nowrap" }}>
                      <button onClick={() => void onLoad(s.id)} style={miniBtn}>{t("glam.saved.open")}</button>
                      <button onClick={() => void onDelete(s.id)} style={miniBtn}>{t("glam.saved.delete")}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── 結果 ── */}
      {analysis && (
        <div style={{ marginTop: 16 }}>
          <div style={summaryRow}>
            <span>{t("glam.summary", {
              voxels: analysis.roiVoxelCount.toLocaleString(),
              bins: analysis.nBins,
              radius: analysis.maxRadius,
            })}</span>
            {!analysis.isotropic && (
              <span style={warnPill}>
                {t("glam.warn.anisotropic", {
                  x: analysis.voxelSpacing[0].toFixed(3),
                  y: analysis.voxelSpacing[1].toFixed(3),
                  z: analysis.voxelSpacing[2].toFixed(3),
                })}
              </span>
            )}
          </div>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 10 }}>
            <div style={card}>
              <div style={sectionTitle}>{t("glam.chart.selfAffinity")}</div>
              <div style={note}>{t("glam.chart.selfAffinity.help")}</div>
              <SelfAffinityChart
                radii={analysis.radii}
                curves={analysis.selfAffinity}
                occupancy={analysis.binOccupancy}
                emptyLabel={t("glam.chart.empty")}
              />
            </div>

            <div style={card}>
              <div style={sectionTitle}>{t("glam.chart.occupancy")}</div>
              <div style={note}>{t("glam.chart.occupancy.help")}</div>
              <BinOccupancyChart occupancy={analysis.binOccupancy} />
              <div style={{ display: "flex", gap: 3, marginTop: 6 }}>
                {analysis.binOccupancy.map((_, i) => (
                  <span key={i} style={{ width: 10, height: 10, background: binColor(i, analysis.nBins) }} />
                ))}
              </div>
            </div>

            <div style={card}>
              <div style={sectionTitle}>{t("glam.chart.matrix")}</div>
              <select value={matrixName} onChange={(e) => setMatrixName(e.target.value)} style={input}>
                {GLAM_MATRICES.map((m) => (
                  <option key={m.name} value={m.name}>{t(m.labelKey)}</option>
                ))}
              </select>
              <div style={note}>{t("glam.chart.matrix.help")}</div>
              {matrix ? (
                <MatrixHeatmap
                  matrix={matrix}
                  diagonalOnly={analysis.diagonalOnly.includes(matrixName)}
                  emptyLabel={t("glam.chart.empty")}
                />
              ) : (
                <div style={note}>{t("glam.chart.empty")}</div>
              )}
              {matrixMeta?.needsBoundaryCorrectionOff && (
                <div style={warnBox}>{t("texture.glam.boundaryWarn")}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "3px 0" }}>
      <span style={{ color: "#5a6672", flex: "none", minWidth: 150 }}>{label}</span>
      <span style={{ flex: 1, textAlign: "right" }}>{children}</span>
    </div>
  );
}

const page: React.CSSProperties = { padding: 16, fontSize: 12, color: "#222", background: "#fff", minHeight: "100vh" };
const header: React.CSSProperties = { fontSize: 15, fontWeight: 600, color: "#0b5cad", marginBottom: 12 };
const panel: React.CSSProperties = {
  border: "1px solid #dfe5ec", borderRadius: 8, padding: 12, minWidth: 380, flex: "1 1 380px", maxWidth: 560,
};
const card: React.CSSProperties = { border: "1px solid #dfe5ec", borderRadius: 8, padding: 12 };
const sectionTitle: React.CSSProperties = { fontWeight: 600, marginBottom: 4 };
const input: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "3px 6px",
};
const note: React.CSSProperties = { color: "#6b7785", fontSize: 11, marginTop: 4, lineHeight: 1.5 };
const errText: React.CSSProperties = { color: "#b00020", marginTop: 8 };
const warnBox: React.CSSProperties = {
  color: "#8a5300", background: "#fff6e5", border: "1px solid #f0d9a8",
  borderRadius: 4, padding: "5px 7px", marginTop: 8, fontSize: 11, lineHeight: 1.5, maxWidth: 280,
};
const warnPill: React.CSSProperties = {
  color: "#8a5300", background: "#fff6e5", border: "1px solid #f0d9a8", borderRadius: 999, padding: "2px 10px",
};
const summaryRow: React.CSSProperties = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" };
const btn: React.CSSProperties = {
  border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "5px 12px",
};
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
const miniBtn: React.CSSProperties = {
  border: "1px solid #cdd5de", borderRadius: 4, background: "#fff", cursor: "pointer", fontSize: 10,
  padding: "2px 6px", marginLeft: 4,
};

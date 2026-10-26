/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * フィルタ層ダイアログと層のバー。フィルタ画像（LoG の派生シリーズ）を、元のタイルへ色を変えて最大 3 本重ねる。
 * 層の r・σ・窓の上限は派生シリーズ 1 枚目のタグから読み、格子（位置・向き・画素間隔・行列・枚数）が元と
 * 一致しないシリーズは理由を出して断る。層は表示の状態だけで保存しない（`filterLayerStore`）。
 */
import { useEffect, useMemo, useState } from "react";
import { useI18n, type TFn } from "../i18n/i18n";
import {
  fetchInstanceTags, fetchInstances, fetchSeries, fetchSeriesLayout,
  type Instance, type Series, type SeriesLayoutDto, type Study,
} from "../api";
import { getFilterLayers, setFilterLayers, useFilterLayers } from "./filterLayerStore";
import {
  MAX_LAYERS, addLayer, gridMismatch, layerMetaFromTags, removeLayer, type FilterLayer, type GridMismatch, type LayerSide,
} from "./filterLayers";

interface Candidate {
  series: Series;
  state:
    | { kind: "ok"; instances: Instance[]; rMm: number; sigmaMm: number; maxAbs: number }
    | { kind: "notLog" }
    | { kind: "mismatch"; why: GridMismatch }
    | { kind: "error"; error: string };
}

const label = (s: Series) => `#${s.seriesNumber ?? "?"} ${s.seriesDescription ?? ""}`.trim();

export function FilterLayerDialog({ tileId, study, series, onClose }: {
  tileId: string;
  study: Study;
  series: Series;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const existing = useFilterLayers(tileId);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [list, baseLayout] = await Promise.all([
          fetchSeries(study.studyInstanceUid),
          fetchSeriesLayout(study.studyInstanceUid, series.seriesInstanceUid),
        ]);
        const logs = list.filter((s) => s.seriesInstanceUid !== series.seriesInstanceUid && /^LoG r/.test(s.seriesDescription ?? ""));
        const out = await Promise.all(logs.map((s) => evaluate(study, s, baseLayout)));
        if (!cancelled) setCands(out);
      } catch (e) {
        if (!cancelled) setError(t("common.fetchError", { error: String(e) }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study.studyInstanceUid, series.seriesInstanceUid]);

  const free = MAX_LAYERS - existing.length;
  const taken = (c: Candidate) => existing.some((l) => l.id === c.series.seriesInstanceUid);
  const toggle = (uid: string) =>
    setPicked((p) => (p.includes(uid) ? p.filter((x) => x !== uid) : p.length < free ? [...p, uid] : p));

  const apply = () => {
    let layers: readonly FilterLayer[] = getFilterLayers(tileId);
    for (const uid of picked) {
      const c = cands?.find((x) => x.series.seriesInstanceUid === uid);
      if (!c || c.state.kind !== "ok") continue;
      const r = addLayer(layers, {
        id: uid, study, series: c.series, instances: c.state.instances,
        rMm: c.state.rMm, sigmaMm: c.state.sigmaMm, maxAbs: c.state.maxAbs,
      });
      if ("layers" in r) layers = r.layers;
    }
    setFilterLayers(tileId, layers);
    onClose();
  };

  return (
    <div style={overlay} onMouseDown={onClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()} data-testid="filter-layer-dialog">
        <div style={header}>{t("filterLayer.title")}</div>
        <div style={note}>{t("filterLayer.note", { n: MAX_LAYERS })}</div>
        {error && <div style={errText}>{error}</div>}
        {!cands && !error && <div style={note}>{t("filterLayer.loading")}</div>}
        {cands && cands.length === 0 && <div style={note} data-testid="filter-layer-none">{t("filterLayer.none")}</div>}
        {cands?.map((c) => {
          const uid = c.series.seriesInstanceUid;
          const ok = c.state.kind === "ok" && !taken(c);
          const off = !ok || (!picked.includes(uid) && picked.length >= free);
          return (
            <div key={uid} style={row} data-testid={`filter-layer-cand-${uid}`}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", flex: 1 }}>
                <input type="checkbox" checked={picked.includes(uid)} disabled={off} onChange={() => toggle(uid)} />
                <span>
                  {c.state.kind === "ok"
                    ? t("filterLayer.legend", { r: c.state.rMm, s: c.state.sigmaMm })
                    : label(c.series)}
                  <span style={{ color: "#6b7785" }}> {label(c.series)}</span>
                </span>
              </label>
              <span style={{ color: "#b00020", fontSize: 11 }} data-testid={`filter-layer-reason-${uid}`}>
                {taken(c) ? t("filterLayer.already") : reasonText(c, t)}
              </span>
            </div>
          );
        })}
        {cands && cands.some((c) => c.state.kind === "ok" && !taken(c)) && picked.length >= free && free > 0 && (
          <div style={note}>{t("filterLayer.maxReached", { n: MAX_LAYERS })}</div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={btn}>{t("common.cancel")}</button>
          <button onClick={apply} disabled={picked.length === 0} style={btnPrimary} data-testid="filter-layer-apply">
            {t("filterLayer.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}

async function evaluate(study: Study, s: Series, baseLayout: SeriesLayoutDto): Promise<Candidate> {
  try {
    const instances = await fetchInstances(study.studyInstanceUid, s.seriesInstanceUid);
    if (instances.length === 0) return { series: s, state: { kind: "notLog" } };
    const tags = await fetchInstanceTags(study.studyInstanceUid, s.seriesInstanceUid, instances[0].sopInstanceUid);
    const meta = layerMetaFromTags(tags);
    if (!meta) return { series: s, state: { kind: "notLog" } };
    const layout = await fetchSeriesLayout(study.studyInstanceUid, s.seriesInstanceUid);
    const why = gridMismatch(baseLayout, layout);
    return why ? { series: s, state: { kind: "mismatch", why } } : { series: s, state: { kind: "ok", instances, ...meta } };
  } catch (e) {
    return { series: s, state: { kind: "error", error: String(e) } };
  }
}

function reasonText(c: Candidate, t: TFn): string {
  switch (c.state.kind) {
    case "ok": return "";
    case "notLog": return t("filterLayer.notLog");
    case "error": return c.state.error;
    case "mismatch": return t(`filterLayer.mismatch.${c.state.why.kind}`, { detail: c.state.why.detail });
  }
}

/** 層のバー（タイルの下）。層ごとに色・凡例・しきい値・見せる側・不透明度・外す。 */
export function FilterLayerBar({ tileId }: { tileId: string }) {
  const { t } = useI18n();
  const layers = useFilterLayers(tileId);
  const edit = (id: string, patch: Partial<FilterLayer>) =>
    setFilterLayers(tileId, layers.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const [texts, setTexts] = useState<Record<string, string>>({});
  const idx = useMemo(() => new Map(layers.map((l, i) => [l.id, i])), [layers]);
  if (layers.length === 0) return null;
  return (
    <div style={bar} data-testid="filter-layer-bar">
      {layers.map((l) => (
        <div key={l.id} style={barRow} data-testid={`filter-layer-row-${l.rMm}`} data-layer-index={idx.get(l.id)}>
          <input
            type="checkbox" checked={l.visible} title={t("filterLayer.visible")} data-testid={`filter-layer-visible-${l.rMm}`}
            onChange={(e) => edit(l.id, { visible: e.target.checked })}
          />
          <span style={{ ...swatch, background: l.color }} data-testid={`filter-layer-swatch-${l.rMm}`} />
          <span style={{ minWidth: 150 }} data-testid={`filter-layer-legend-${l.rMm}`}>
            {t("filterLayer.legend", { r: l.rMm, s: l.sigmaMm })}
          </span>
          <label>
            {t("filterLayer.threshold")}{" "}
            <input
              type="number" step="any" min={0} style={{ width: 62 }} data-testid={`filter-layer-threshold-${l.rMm}`}
              value={texts[l.id] ?? String(l.threshold)}
              onChange={(e) => {
                setTexts((p) => ({ ...p, [l.id]: e.target.value }));
                const v = Number(e.target.value);
                if (e.target.value.trim() !== "" && Number.isFinite(v) && v >= 0) edit(l.id, { threshold: v });
              }}
            />
          </label>
          <select
            value={l.side} data-testid={`filter-layer-side-${l.rMm}`} title={t("filterLayer.sideHelp")}
            onChange={(e) => edit(l.id, { side: e.target.value as LayerSide })}
          >
            <option value="negative">{t("filterLayer.side.negative")}</option>
            <option value="positive">{t("filterLayer.side.positive")}</option>
          </select>
          <label>
            {t("viewer2d.fusion.opacity")}{" "}
            <input
              type="range" min={0} max={100} style={{ width: 70, verticalAlign: "middle" }}
              data-testid={`filter-layer-opacity-${l.rMm}`} value={Math.round(l.opacity * 100)}
              onChange={(e) => edit(l.id, { opacity: Number(e.target.value) / 100 })}
            />
          </label>
          <button
            style={xbtn} title={t("filterLayer.remove")} data-testid={`filter-layer-remove-${l.rMm}`}
            onClick={() => setFilterLayers(tileId, removeLayer(layers, l.id))}
          >×</button>
        </div>
      ))}
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,0.35)",
  display: "flex", alignItems: "center", justifyContent: "center",
};
const panel: React.CSSProperties = {
  width: 520, maxHeight: "90vh", overflowY: "auto", background: "#fff", border: "1px solid #cfd8e2",
  borderRadius: 8, boxShadow: "0 12px 40px rgba(0,0,0,0.25)", padding: 16, fontSize: 12, color: "#222",
};
const header: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: "#0b5cad", marginBottom: 8 };
const note: React.CSSProperties = { color: "#6b7785", fontSize: 11, margin: "6px 0", lineHeight: 1.5 };
const errText: React.CSSProperties = { color: "#b00020", margin: "8px 0" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderTop: "1px solid #eef1f5" };
const btn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "4px 12px" };
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
const bar: React.CSSProperties = { borderTop: "1px solid #e1e7ee", background: "#f0f5fb", padding: "4px 10px", flex: "none", fontSize: 11 };
const barRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "2px 0" };
const swatch: React.CSSProperties = { width: 14, height: 14, borderRadius: 3, border: "1px solid #8a98a6", flex: "none" };
const xbtn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 4, background: "#fff", cursor: "pointer", fontSize: 12, lineHeight: 1, padding: "1px 6px" };

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 「連結して開く」ダイアログ。選んだ複数のシリーズを、開くときだけ 1 本につなぐ（DB・ファイルは変えない）。
 * 連結できるかの判定と、継ぎ目の重なり・隙間（mm）を開く前に出す。判定と並べ方は純関数
 * （{@link checkConcat}・{@link concatLayouts}）。
 */
import { useEffect, useMemo, useState } from "react";
import { fetchSeriesLayout, type Series, type Study } from "../api";
import { useI18n } from "../i18n/i18n";
import { buildLayoutFromDto } from "../viewer/seriesLayout";
import type { ViewerMode } from "../viewer/imageId";
import {
  concatLayouts, concatPartFromDto, positionsMm, type ConcatOpened, type ConcatPart, type ConcatResult,
} from "../viewer/virtualLayout";

export interface ConcatPick { study: Study; series: Series }

export const seriesShortLabel = (se: Series) =>
  `#${se.seriesNumber ?? "?"} ${se.modality ?? ""} ${se.seriesDescription ?? ""}`.trim();

type Loaded =
  | { ok: true; part: ConcatPart; fromMm: number | null; toMm: number | null }
  | { ok: false; reason: string };

export function OpenConcatDialog({
  mode, picks, onOpen, onClose,
}: {
  mode: ViewerMode;
  picks: ConcatPick[];
  onOpen: (opened: ConcatOpened) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<Loaded[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    Promise.all(picks.map(async ({ study, series }): Promise<Loaded> => {
      try {
        const dto = await fetchSeriesLayout(study.studyInstanceUid, series.seriesInstanceUid);
        const layout = buildLayoutFromDto(dto, mode, study.studyInstanceUid, series.seriesInstanceUid);
        if (!layout) return { ok: false, reason: "layoutFailed" };
        const part = concatPartFromDto(
          {
            study: study.studyInstanceUid,
            series: series.seriesInstanceUid,
            layout,
            patientId: study.patientId ?? "",
            modality: series.modality ?? "",
          },
          dto,
        );
        if ("missing" in part) return { ok: false, reason: `missing.${part.missing}` };
        const pos = positionsMm(layout);
        return { ok: true, part, fromMm: pos ? Math.min(...pos) : null, toMm: pos ? Math.max(...pos) : null };
      } catch {
        return { ok: false, reason: "layoutFailed" };
      }
    })).then((r) => { if (!cancelled) setLoaded(r); });
    return () => { cancelled = true; };
  }, [picks, mode]);

  const labels = useMemo(() => picks.map((p) => seriesShortLabel(p.series)), [picks]);
  const failures = loaded ? loaded.flatMap((l, i) => (l.ok ? [] : [{ i, reason: l.reason }])) : [];
  const result: ConcatResult | null = useMemo(() => {
    if (!loaded || loaded.some((l) => !l.ok)) return null;
    return concatLayouts(loaded.map((l) => (l as Extract<Loaded, { ok: true }>).part));
  }, [loaded]);

  return (
    <div style={backdrop} data-testid="open-concat-dialog" onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{t("openConcat.title")}</div>
        {!loaded && <div>{t("common.loading")}</div>}
        {loaded && (
          <>
            <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 12 }}>
              {picks.map((p, i) => {
                const l = loaded[i];
                return (
                  <li key={p.series.seriesInstanceUid}>
                    {labels[i]} ({p.series.numberOfInstances})
                    {l.ok && l.fromMm !== null && l.toMm !== null && ` / ${t("openRange.position", { from: l.fromMm.toFixed(1), to: l.toMm.toFixed(1) })}`}
                  </li>
                );
              })}
            </ul>
            <div style={{ minHeight: 40, fontSize: 12 }} data-testid="open-concat-status">
              {failures.map((f) => (
                <div key={f.i} style={{ color: "#b3261e" }}>{labels[f.i]}: {t(`openConcat.${f.reason.startsWith("missing") ? "" : "fail."}${f.reason}`)}</div>
              ))}
              {result && !result.ok && result.violations.map((v) => (
                <div key={v} style={{ color: "#b3261e" }} data-testid={`open-concat-violation-${v}`}>{t(`openConcat.fail.${v}`)}</div>
              ))}
              {result && result.ok && (
                <>
                  <div data-testid="open-concat-ok">{t("openConcat.ok", { count: result.layout.nZ })}</div>
                  {result.joints.map((j) => (
                    <div key={j.index} data-testid="open-concat-joint">
                      {t("openConcat.joint", { before: labels[j.before], after: labels[j.after] })}
                      {j.gapMm > 0
                        ? ` ${t("series.concat.gap", { mm: j.gapMm.toFixed(1) })}`
                        : j.overlapMm > 0 ? ` ${t("series.concat.overlap", { mm: j.overlapMm.toFixed(1) })}` : ""}
                    </div>
                  ))}
                </>
              )}
            </div>
          </>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
          <button type="button" onClick={onClose}>{t("common.cancel")}</button>
          <button
            type="button" data-testid="open-concat-confirm"
            disabled={!result || !result.ok}
            onClick={() => result && result.ok && onOpen({
              layout: result.layout, cells: result.cells, joints: result.joints, labels,
            })}
          >{t("openConcat.open")}</button>
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
  background: "#fff", color: "#1a1a1a", borderRadius: 8, padding: 16, width: 460,
  boxShadow: "0 8px 30px rgba(0,0,0,0.3)", fontFamily: "system-ui, sans-serif",
};

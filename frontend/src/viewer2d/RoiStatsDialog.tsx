/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI 計測結果ダイアログ（`fw/roi-stats-design.md` §6.2）。
 *
 * <p>ROI マネージャの Σ から開く。**統計を常に画像へ載せておかなくても値を見られる**ようにする、
 * というのがこの画面の役割。上段は一覧（CSV へそのまま出せる形）、下段は選択した 1 件の詳細
 * （面型はヒストグラム、開いた ROI は線プロファイル）。
 *
 * <p>🔴 **整形は `viewer/roiStatsText.ts` を通す**（ROI 脇の表示と同じ関数）。ここで独自に
 * 数字を整えると「脇の値とダイアログの値が違う」という、いちばん信用を落とす食い違いになる。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { emitToast } from "../viewer/toast";
import { getRoiMaskMeta } from "../viewer/roiMaskStore";
import { computeRoiStatsAsync } from "../viewer/roiStatsStore";
import { roiStatsCsvBlobText, roiStatsToCsv, type RoiStatsCsvRow } from "../viewer/roiStatsCsv";
import {
  formatArea,
  formatLength,
  formatNumber,
  formatValue,
  valueUnitLabel,
} from "../viewer/roiStatsText";
import { ENTROPY_BINS, type RoiStatsResult } from "../viewer/roiStats";
import { LoadingSpinner } from "../viewer/LoadingSpinner";

const CHART_W = 520;
const CHART_H = 150;

export interface RoiStatsTarget {
  uid: string;
  tool: string;
}

export function RoiStatsDialog({
  targets,
  initialUid,
  onClose,
}: {
  /** 対象 ROI（ROI マネージャに出ている順）。 */
  targets: RoiStatsTarget[];
  /** 開いた直後に詳細を出す ROI。 */
  initialUid?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [stats, setStats] = useState<Record<string, RoiStatsResult>>({});
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<string | null>(initialUid ?? targets[0]?.uid ?? null);
  const [generation, setGeneration] = useState(0);

  // 一覧ぶんの統計。画素が未ロードのスライスもあるので非同期で読み込む。
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    (async () => {
      const out: Record<string, RoiStatsResult> = {};
      for (const target of targets) {
        // 詳細（ヒストグラム/プロファイル）は選択中の 1 件だけ作る。全件ぶん作ると重い。
        const detail = target.uid === focus;
        const r = await computeRoiStatsAsync(target.uid, {
          withProfile: detail,
          withHistogram: detail,
          force: generation > 0,
        });
        if (cancelled) return;
        if (r) out[target.uid] = r;
      }
      if (cancelled) return;
      setStats(out);
      setBusy(false);
    })().catch(() => {
      if (!cancelled) setBusy(false);
    });
    return () => {
      cancelled = true;
    };
  }, [targets, focus, generation]);

  const rows = useMemo<RoiStatsCsvRow[]>(
    () =>
      targets.map((target, i) => ({
        index: i + 1,
        label: getRoiMaskMeta(target.uid)?.label ?? "",
        tool: target.tool,
        stats: stats[target.uid],
      })),
    [targets, stats],
  );

  const copyCsv = useCallback(() => {
    navigator.clipboard
      ?.writeText(roiStatsToCsv(rows))
      .then(() => emitToast(t("roiStats.csvCopied")))
      .catch(() => emitToast(t("roiStats.csvFailed")));
  }, [rows, t]);

  const saveCsv = useCallback(() => {
    const url = URL.createObjectURL(
      new Blob([roiStatsCsvBlobText(rows)], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "roi-stats.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, [rows]);

  const focused = focus ? stats[focus] : undefined;

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()} data-testid="roi-stats-dialog">
        <div style={dlgHead}>
          <strong style={{ fontSize: 13 }}>{t("roiStats.title")}</strong>
          <span style={{ flex: 1 }} />
          {busy && <LoadingSpinner size={14} />}
          <button onClick={() => setGeneration((g) => g + 1)} style={hbtn} title={t("roiStats.recompute")}>⟳</button>
          <button onClick={copyCsv} style={hbtn} title={t("roiStats.copyCsv")}>⧉ CSV</button>
          <button onClick={saveCsv} style={hbtn} title={t("roiStats.saveCsv")}>⬇ CSV</button>
          <button onClick={onClose} style={hbtn} title={t("common.close")}>×</button>
        </div>

        {targets.length === 0 ? (
          <div style={{ padding: 16, color: "#5a6672" }}>{t("roiStats.empty")}</div>
        ) : (
          <>
            <div style={tableWrap}>
              <table style={table}>
                <thead>
                  <tr>
                    <th style={th}>#</th>
                    <th style={th}>{t("roiMgr.label")}</th>
                    <th style={th}>{t("roiStats.col.size")}</th>
                    <th style={thNum}>{t("roiStats.mean")}</th>
                    <th style={thNum}>SD</th>
                    <th style={thNum}>{t("roiStats.min")}</th>
                    <th style={thNum}>{t("roiStats.max")}</th>
                    <th style={thNum}>{t("roiStats.n")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const s = r.stats;
                    const v = s?.values;
                    const uid = targets[i].uid;
                    const size = s ? (s.geometry.kind === "area" ? formatArea(s) : formatLength(s)) : null;
                    return (
                      <tr
                        key={uid}
                        onClick={() => setFocus(uid)}
                        style={{ ...tr, ...(uid === focus ? trFocused : null) }}
                      >
                        <td style={td}>{r.index}</td>
                        <td style={td}>{r.label || targets[i].tool}</td>
                        <td style={td}>{size ?? "—"}</td>
                        <td style={tdNum}>{v ? formatNumber(v.mean) : "—"}</td>
                        <td style={tdNum}>{v ? formatNumber(v.sd) : "—"}</td>
                        <td style={tdNum}>{v ? formatNumber(v.min) : "—"}</td>
                        <td style={tdNum}>{v ? formatNumber(v.max) : "—"}</td>
                        <td style={tdNum}>{s ? s.geometry.sampleCount : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={detailBox}>{focused ? <Detail stats={focused} /> : <span style={dim}>—</span>}</div>
          </>
        )}
      </div>
    </div>
  );
}

/** 選択した 1 件の詳細。 */
function Detail({ stats }: { stats: RoiStatsResult }) {
  const { t } = useI18n();
  const g = stats.geometry;
  const v = stats.values;
  const size = g.kind === "area" ? formatArea(stats) : formatLength(stats);

  const geomParts: string[] = [];
  if (size) geomParts.push(`${t(g.kind === "area" ? "roiStats.area" : "roiStats.length")}: ${size}`);
  if (g.kind === "area") {
    const per = formatLength(stats);
    if (per) geomParts.push(`${t("roiStats.perimeter")}: ${per}`);
  }
  if (g.longAxisMm !== undefined && g.shortAxisMm !== undefined) {
    geomParts.push(`${t("roiStats.axes")}: ${formatNumber(g.longAxisMm)} × ${formatNumber(g.shortAxisMm)} mm`);
  }
  geomParts.push(`${t("roiStats.n")}: ${g.sampleCount}`);

  return (
    <>
      <div style={detailLine}>{geomParts.join(" / ")}</div>
      {v ? (
        <div style={detailLine}>
          {`n=${v.n}  ${t("roiStats.mean")} ${formatValue(v.mean, v.unit, t)}  SD ${formatNumber(v.sd)}  `}
          {`${t("roiStats.median")} ${formatNumber(v.median)}  p5 ${formatNumber(v.p5)}  p95 ${formatNumber(v.p95)}  `}
          {`${t("roiStats.skewness")} ${formatNumber(v.skewness)}  ${t("roiStats.kurtosis")} ${formatNumber(v.kurtosis)}  `}
          {`${t("roiStats.entropy")} ${formatNumber(v.entropy)}`}
          <span style={dim}> ({t("roiStats.bins", { n: ENTROPY_BINS })})</span>
        </div>
      ) : (
        <div style={{ ...detailLine, ...dim }}>{t("roiStats.noValues")}</div>
      )}

      {stats.profile ? (
        <LineChart
          xs={stats.profile.distance}
          ys={stats.profile.values}
          xLabel={stats.profile.distanceUnit}
          yLabel={valueUnitLabel(v?.unit ?? "", t)}
        />
      ) : stats.histogram ? (
        <Histogram
          counts={stats.histogram.counts}
          binStart={stats.histogram.binStart}
          binWidth={stats.histogram.binWidth}
          yLabel={valueUnitLabel(v?.unit ?? "", t)}
        />
      ) : null}

      <div style={{ ...detailLine, ...dim }}>
        {t("roiStats.source", { imageId: shortImageId(stats.imageId) })}
      </div>
      {stats.warnings.length > 0 && (
        <div style={{ ...detailLine, color: "#b26a00" }}>
          {stats.warnings.map((w) => t(`roiStats.warn.${w}`)).join(" / ")}
        </div>
      )}
    </>
  );
}

/** imageId は長い URL なので、末尾（SOP とフレーム）だけ見せる。 */
function shortImageId(id: string): string {
  const m = /instances\/([^/?&]+)/.exec(id);
  const frame = /frame=(\d+)/.exec(id);
  const sop = m ? m[1] : id.slice(-24);
  return frame ? `${sop} (frame ${frame[1]})` : sop;
}

/** 依存ライブラリ無しの棒グラフ（`RoiHistogramChart` と同じ様式）。 */
function Histogram({
  counts,
  binStart,
  binWidth,
  yLabel,
}: {
  counts: number[];
  binStart: number;
  binWidth: number;
  yLabel: string;
}) {
  const peak = Math.max(1, ...counts);
  const bw = CHART_W / Math.max(1, counts.length);
  return (
    <svg width={CHART_W} height={CHART_H} style={chart}>
      {counts.map((c, i) =>
        c <= 0 ? null : (
          <rect
            key={i}
            x={i * bw}
            y={CHART_H - (c / peak) * (CHART_H - 18)}
            width={Math.max(1, bw)}
            height={(c / peak) * (CHART_H - 18)}
            fill="#2d7ff9"
            opacity={0.75}
          />
        ),
      )}
      <text x={2} y={12} fontSize={10} fill="#5a6672">
        {formatNumber(binStart)} {yLabel}
      </text>
      <text x={CHART_W - 2} y={12} fontSize={10} fill="#5a6672" textAnchor="end">
        {formatNumber(binStart + binWidth * counts.length)} {yLabel}
      </text>
    </svg>
  );
}

/** 線プロファイル（距離 - 値）。 */
function LineChart({
  xs,
  ys,
  xLabel,
  yLabel,
}: {
  xs: Float32Array;
  ys: Float32Array;
  xLabel: string;
  yLabel: string;
}) {
  const path = useMemo(() => {
    if (!xs.length) return "";
    let minY = Infinity;
    let maxY = -Infinity;
    for (const y of ys) {
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const spanY = maxY - minY || 1;
    const spanX = xs[xs.length - 1] - xs[0] || 1;
    const pts: string[] = [];
    for (let i = 0; i < xs.length; i++) {
      const px = ((xs[i] - xs[0]) / spanX) * CHART_W;
      const py = 16 + (1 - (ys[i] - minY) / spanY) * (CHART_H - 24);
      pts.push(`${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`);
    }
    return pts.join(" ");
  }, [xs, ys]);

  return (
    <svg width={CHART_W} height={CHART_H} style={chart}>
      <path d={path} fill="none" stroke="#2d7ff9" strokeWidth={1.2} />
      <text x={2} y={12} fontSize={10} fill="#5a6672">
        {yLabel}
      </text>
      <text x={CHART_W - 2} y={CHART_H - 2} fontSize={10} fill="#5a6672" textAnchor="end">
        {formatNumber(xs[xs.length - 1] ?? 0)} {xLabel}
      </text>
    </svg>
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", zIndex: 1000,
  display: "flex", alignItems: "center", justifyContent: "center",
};
const dialog: React.CSSProperties = {
  width: 600, maxHeight: "85vh", overflowY: "auto", background: "#fff",
  borderRadius: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.25)", fontSize: 12,
  display: "flex", flexDirection: "column",
};
const dlgHead: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "8px 10px", borderBottom: "1px solid #e6eaee" };
const hbtn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 12, padding: "1px 7px" };
const tableWrap: React.CSSProperties = { maxHeight: 220, overflow: "auto" };
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12 };
const th: React.CSSProperties = { textAlign: "left", padding: "4px 6px", borderBottom: "1px solid #e6eaee", color: "#5a6672", position: "sticky", top: 0, background: "#fff" };
const thNum: React.CSSProperties = { ...th, textAlign: "right" };
const tr: React.CSSProperties = { cursor: "pointer" };
const trFocused: React.CSSProperties = { background: "#eef5ff" };
const td: React.CSSProperties = { padding: "3px 6px", borderBottom: "1px solid #f1f4f7", whiteSpace: "nowrap" };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const detailBox: React.CSSProperties = { padding: "8px 10px", borderTop: "1px solid #e6eaee", display: "flex", flexDirection: "column", gap: 4 };
const detailLine: React.CSSProperties = { color: "#33404d", lineHeight: 1.5 };
const dim: React.CSSProperties = { color: "#8a95a1" };
const chart: React.CSSProperties = { background: "#f7f9fb", borderRadius: 4, maxWidth: "100%" };

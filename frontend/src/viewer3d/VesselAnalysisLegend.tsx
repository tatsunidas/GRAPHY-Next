/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 血管に乗せた解析値（FFR 等）の凡例。`fw/angio-design.md` §11（A7）。
 *
 * <h3>🔴 出さなければならないもの</h3>
 * 値と色だけでは足りない。**この数字がどこから来て、どこまで信じてよいか**を同じ場所に出す:
 *
 * - **どのモジュールの、どの版が出したか**（本体は計算していない・§11.1）
 * - **モジュール提供元の免責文**（そのまま。要約も書き換えもしない）
 * - **幾何の校正の縮退区分**（近似には近似と書く・§7.4）。未校正の幾何から出た値は、
 *   数字としてはもっともらしく見えるので、ここに書かないと誰も気付かない
 * - **値が無い区間はグレー**であること（補間していない＝解析していない）
 *
 * <p>既存の {@link ./ColorLegend} は VR の LUT と VOI に結び付いていて
 * （`VtkVolumeView` を引数に取る）、ボリュームの無いこのウィンドウには載らない。
 * 色の決定は `vesselColorMap.ts` に閉じているので、そこから目盛りを作る。
 */
import { useI18n } from "../i18n/i18n";
import type { XaVesselAnalysis, XaVesselModel } from "../viewer/xaVesselModelStore";
import { cssRgb, legendStops, NO_VALUE_RGB } from "./vesselColorMap";

export function VesselAnalysisLegend({
  analysis,
  model,
}: {
  analysis: XaVesselAnalysis;
  model: XaVesselModel | null;
}) {
  const { t } = useI18n();
  const stops = legendStops(24);
  // 下端が range[0]（赤）。CSS のグラデーションは上から並ぶので反転して積む。
  const gradient = `linear-gradient(to top, ${stops
    .map((s) => `${cssRgb(s.rgb)} ${(s.t * 100).toFixed(1)}%`)
    .join(", ")})`;
  // 🔴 1 方向でも近似なら結果は近似。最も弱い区分を出す。
  const tiers = model?.calibration.tiers ?? [];
  const tier = tiers.includes("uncalibrated")
    ? "uncalibrated"
    : tiers.includes("approximate")
      ? "approximate"
      : tiers.length > 0
        ? "calibrated"
        : null;

  return (
    <div style={box} data-testid="vessel-legend" data-label={analysis.label}>
      <div style={header}>{analysis.label}</div>
      <div style={barRow}>
        <div style={{ ...bar, background: gradient }} />
        <div style={ticks}>
          <span data-testid="vessel-legend-max">{analysis.range[1]}</span>
          <span data-testid="vessel-legend-min">{analysis.range[0]}</span>
        </div>
      </div>
      <div style={noValueRow}>
        <span style={{ ...swatch, background: cssRgb(NO_VALUE_RGB) }} />
        {t("vessel.noValue")}
      </div>
      {/* 出所。**本体は計算していない**ことが読み取れる形にする。 */}
      <div style={line} data-testid="vessel-legend-source">
        {t("vessel.computedBy")}: {analysis.source.pluginName} {analysis.source.version}
      </div>
      {tier && tier !== "calibrated" ? (
        <div style={warn} data-testid="vessel-legend-tier">
          {tier === "uncalibrated" ? t("vessel.uncalibratedGeometry") : t("vessel.approximateGeometry")}
        </div>
      ) : null}
      {model && !model.calibration.diameterCalibrated ? (
        <div style={warn} data-testid="vessel-legend-nodiameter">{t("vessel.noDiameter")}</div>
      ) : null}
      {model?.calibration.diameterMethod === "mixed" ? (
        <div style={warn} data-testid="vessel-legend-mixed">{t("vessel.mixedMethod")}</div>
      ) : null}
      {model?.provenance.angleCorrected === false ? (
        <div style={warn} data-testid="vessel-legend-notrefined">{t("xa3d.notRefined")}</div>
      ) : null}
      {/* モジュール提供元の免責文は**そのまま**出す。 */}
      {analysis.disclaimer ? (
        <div style={disclaimer} data-testid="vessel-legend-disclaimer">
          {analysis.disclaimer}
        </div>
      ) : null}
    </div>
  );
}

const box: React.CSSProperties = {
  position: "absolute",
  right: 10,
  top: 10,
  width: 210,
  padding: "8px 10px",
  background: "rgba(13,18,22,0.86)",
  border: "1px solid #1e2a33",
  borderRadius: 4,
  fontSize: 11,
  color: "#dfe7ee",
  pointerEvents: "none",
};
const header: React.CSSProperties = { fontWeight: 600, fontSize: 12, marginBottom: 6 };
const barRow: React.CSSProperties = { display: "flex", gap: 8, height: 110 };
const bar: React.CSSProperties = { width: 16, borderRadius: 2, border: "1px solid #33424e" };
const ticks: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  fontVariantNumeric: "tabular-nums",
};
const noValueRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginTop: 6,
  color: "#8fa1b0",
};
const swatch: React.CSSProperties = {
  width: 12,
  height: 12,
  borderRadius: 2,
  border: "1px solid #33424e",
  display: "inline-block",
};
const line: React.CSSProperties = { marginTop: 6, color: "#8fa1b0", wordBreak: "break-word" };
const warn: React.CSSProperties = { marginTop: 4, color: "#e0a35a" };
const disclaimer: React.CSSProperties = {
  marginTop: 6,
  paddingTop: 6,
  borderTop: "1px solid #1e2a33",
  color: "#b9c6d1",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

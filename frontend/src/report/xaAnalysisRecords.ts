/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA の解析結果 → レポート用の記録（`fw/angio-design.md` §21.5 / A14）。
 *
 * <p>各ダイアログが自前で文面を組むと、**同じ量が画面と SR とレポートで別々の書き方**になる。
 * ここに集めて、**SR に書いている内容と食い違わせない**（§19）。
 *
 * <h3>🔴 系統誤差の文言をここで決める（§21.5 の未決事項）</h3>
 * MLD/RVD/断面積を**絶対値で報告書に載せる以上、避けて通れない**ので、
 * **絶対値を 1 つでも載せるときは必ず** §16.4 の注記を付ける。
 * 一方 **%DS/%AS は比なので打ち消される**（3D では厳密。§10.2.8）——
 * 同じ注記を付けると「狭窄率も 13% ずれている」と誤読されるので、**別の文にする**。
 */

import { type AnalysisResultRecord } from "./analysisResults";

/** i18n の解決関数（`useI18n()` の `t`）。 */
export type Translate = (key: string, params?: Record<string, string>) => string;

/** 研究用であることは、どの解析でも必ず言う。 */
function common(t: Translate): string[] {
  return [t("report.analysis.caveat.researchOnly")];
}

/** 絶対値（径・面積・容積）を載せるときの系統誤差の注記。 */
function absoluteDiameterCaveat(t: Translate): string {
  return t("report.analysis.caveat.diameterBias");
}

export interface QcaRecordInput {
  studyUid: string;
  seriesUid: string;
  sopInstanceUid: string;
  /** 0 origin。表示は +1 する。 */
  frameIndex: number;
  vesselLabel?: string | null;
  unit: "mm" | "px";
  calibration: string | null;
  /** 手修正の説明（`describeManual`）。null なら全自動。 */
  manualCorrection: string | null;
  mld: number;
  rvd: number;
  percentDiameterStenosis: number;
  percentAreaStenosis: number;
  lesionLength: number;
}

export function qcaRecord(i: QcaRecordInput, t: Translate): AnalysisResultRecord {
  const u = i.unit;
  const caveats = [...common(t)];
  // 🔴 px のときは「13% 過小」より先に「そもそも mm ではない」を言う。
  if (u === "px") caveats.unshift(t("report.analysis.caveat.uncalibrated"));
  else caveats.unshift(absoluteDiameterCaveat(t));
  if (i.manualCorrection) caveats.push(t("report.analysis.caveat.manual"));
  return {
    id: `qca:${i.sopInstanceUid}:${i.frameIndex}`,
    kind: "qca",
    studyUid: i.studyUid,
    seriesUid: i.seriesUid,
    sopInstanceUids: [i.sopInstanceUid],
    frameLabel: t("report.analysis.frame", { n: String(i.frameIndex + 1) }),
    title: i.vesselLabel ? `${t("report.analysis.title.qca")}（${i.vesselLabel}）` : t("report.analysis.title.qca"),
    metrics: [
      { label: "MLD", value: i.mld.toFixed(2), unit: u },
      { label: "RVD", value: i.rvd.toFixed(2), unit: u },
      { label: t("report.analysis.metric.percentDs"), value: i.percentDiameterStenosis.toFixed(1), unit: "%" },
      { label: t("report.analysis.metric.percentAs"), value: i.percentAreaStenosis.toFixed(1), unit: "%" },
      { label: t("report.analysis.metric.lesionLength"), value: i.lesionLength.toFixed(1), unit: u },
    ],
    provenance: [
      { label: t("report.analysis.prov.calibration"), value: i.calibration ?? t("report.analysis.prov.none") },
      {
        label: t("report.analysis.prov.manual"),
        value: i.manualCorrection ?? t("report.analysis.prov.automatic"),
      },
    ],
    caveats,
    at: Date.now(),
  };
}

export interface QlvRecordInput {
  studyUid: string;
  seriesUid: string;
  sopInstanceUid: string;
  edFrame: number;
  esFrame: number;
  framesManual: boolean;
  calibration: string | null;
  ejectionFraction: number;
  edvMl: number | null;
  esvMl: number | null;
  kennedyEjectionFraction: number | null;
}

export function qlvRecord(i: QlvRecordInput, t: Translate): AnalysisResultRecord {
  const calibrated = i.edvMl != null && i.esvMl != null;
  const metrics = [
    { label: t("report.analysis.metric.ef"), value: i.ejectionFraction.toFixed(1), unit: "%" },
  ];
  if (calibrated) {
    metrics.push({ label: "EDV", value: i.edvMl!.toFixed(1), unit: "mL" });
    metrics.push({ label: "ESV", value: i.esvMl!.toFixed(1), unit: "mL" });
    if (i.kennedyEjectionFraction != null) {
      metrics.push({
        label: t("report.analysis.metric.efKennedy"),
        value: i.kennedyEjectionFraction.toFixed(1),
        unit: "%",
      });
    }
  }
  const caveats = [t("report.analysis.caveat.areaLength"), ...common(t)];
  // 🔑 未校正でも EF は正しい（スケール不変）。「未校正だから全部だめ」と読ませない。
  if (!calibrated) caveats.unshift(t("report.analysis.caveat.qlvUncalibrated"));
  if (!i.framesManual) caveats.push(t("report.analysis.caveat.framesAuto"));
  return {
    id: `qlv:${i.sopInstanceUid}:${i.edFrame}:${i.esFrame}`,
    kind: "qlv",
    studyUid: i.studyUid,
    seriesUid: i.seriesUid,
    sopInstanceUids: [i.sopInstanceUid],
    frameLabel: t("report.analysis.frames.edEs", { ed: String(i.edFrame + 1), es: String(i.esFrame + 1) }),
    title: t("report.analysis.title.qlv"),
    metrics,
    provenance: [
      { label: t("report.analysis.prov.calibration"), value: i.calibration ?? t("report.analysis.prov.none") },
      {
        label: t("report.analysis.prov.frameSelection"),
        value: i.framesManual ? t("report.analysis.prov.manualFrames") : t("report.analysis.prov.autoFrames"),
      },
    ],
    caveats,
    at: Date.now(),
  };
}

export interface Qca3dRecordInput {
  studyUid: string;
  seriesUid: string;
  viewASopInstanceUid: string;
  viewBSopInstanceUid: string;
  viewALabel: string;
  viewBLabel: string;
  separationDeg: number;
  anchorCount: number;
  anchorReprojectionPx: number;
  angleCorrected: boolean;
  lengthMm: number;
  minEquivalentDiameterMm: number | null;
  percentDiameterStenosis: number | null;
  visibleFractionA: number | null;
  visibleFractionB: number | null;
}

export function qca3dRecord(i: Qca3dRecordInput, t: Translate): AnalysisResultRecord {
  const metrics = [{ label: t("report.analysis.metric.length3d"), value: i.lengthMm.toFixed(1), unit: "mm" }];
  if (i.minEquivalentDiameterMm != null) {
    metrics.push({ label: "MLD (3D)", value: i.minEquivalentDiameterMm.toFixed(2), unit: "mm" });
  }
  if (i.percentDiameterStenosis != null) {
    metrics.push({
      label: t("report.analysis.metric.percentDs"),
      value: i.percentDiameterStenosis.toFixed(1),
      unit: "%",
    });
  }

  const caveats = [t("report.analysis.caveat.pose"), ...common(t)];
  // 🔴 絶対値を載せるときだけ系統誤差の注記。%DS だけなら付けない（比では打ち消されるため）。
  if (i.minEquivalentDiameterMm != null) caveats.unshift(absoluteDiameterCaveat(t));
  // 🚨 角度補正が掛かっていない結果は装置の角度誤差をそのまま含む。**必ず言う**。
  if (!i.angleCorrected) caveats.unshift(t("report.analysis.caveat.notAngleCorrected"));
  // 🔴 短縮している方向があると長さが系統的に短く出る（§10.3.1）。
  const worst = Math.min(i.visibleFractionA ?? 1, i.visibleFractionB ?? 1);
  if (worst < 0.8) {
    caveats.unshift(t("report.analysis.caveat.foreshortened", { pct: (worst * 100).toFixed(0) }));
  }

  return {
    id: `qca3d:${i.viewASopInstanceUid}:${i.viewBSopInstanceUid}`,
    kind: "qca3d",
    studyUid: i.studyUid,
    seriesUid: i.seriesUid,
    sopInstanceUids: [i.viewASopInstanceUid, i.viewBSopInstanceUid],
    frameLabel: `${i.viewALabel} / ${i.viewBLabel}`,
    title: t("report.analysis.title.qca3d"),
    metrics,
    provenance: [
      { label: t("report.analysis.prov.separation"), value: `${i.separationDeg.toFixed(1)}°` },
      {
        label: t("report.analysis.prov.anchors"),
        value: t("report.analysis.prov.anchorsValue", {
          n: String(i.anchorCount),
          px: i.anchorReprojectionPx.toFixed(2),
        }),
      },
      {
        label: t("report.analysis.prov.angleCorrection"),
        value: i.angleCorrected
          ? t("report.analysis.prov.applied")
          : t("report.analysis.prov.notApplied"),
      },
    ],
    caveats,
    at: Date.now(),
  };
}

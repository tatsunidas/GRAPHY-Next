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

import { type AnalysisMetric, type AnalysisResultRecord } from "./analysisResults";

/** i18n の解決関数（`useI18n()` の `t`）。 */
export type Translate = (key: string, params?: Record<string, string>) => string;

/** 研究用であることは、どの解析でも必ず言う。 */
function common(t: Translate): string[] {
  return [t("report.analysis.caveat.researchOnly")];
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

/* ------------------------------------------------------------------ */
/* TIMI フレームカウント（A15）                                        */
/* ------------------------------------------------------------------ */

export interface TimiRecordInput {
  result: {
    vessel: string;
    startFrame: number;
    endFrame: number;
    frames: number;
    elapsedMs: number | null;
    tfc30: number | null;
    ctfc: number | null;
    fps: number;
    fpsSource: string;
    warnings: string[];
  };
  studyUid: string;
  seriesUid: string;
  sopInstanceUid: string | null;
  /** 時間輝度カーブの ROI を引いたときのフレーム（引いていなければ null）。 */
  roiFrame: number | null;
}

/**
 * レポートへ差し込む 1 件。
 *
 * <h3>🔴 換算できていないときに生のフレーム差を報告値にしない</h3>
 * `tfc30` が null（撮影レートのタグが無い）なら **TFC の行を出さない**。
 * 生のフレーム差は「数えた事実」として別の行に出すが、それは撮影条件に依る値なので
 * **TFC とは呼ばない**。読んだ人が 30fps 撮影だと誤解しないよう、注意書きにも出す。
 */
export function timiRecord(i: TimiRecordInput, t: Translate): AnalysisResultRecord {
  const r = i.result;
  const metrics: AnalysisMetric[] = [
    { label: t("timi.result.frames"), value: String(r.frames), unit: "frames" },
  ];
  if (r.tfc30 != null) {
    metrics.push({ label: t("timi.result.tfc30"), value: r.tfc30.toFixed(1), unit: "frames@30fps" });
  }
  if (r.ctfc != null) {
    metrics.push({ label: t("timi.result.ctfc"), value: r.ctfc.toFixed(1), unit: "frames@30fps" });
  }

  const caveats = [t("timi.notFlowGrade"), ...common(t)];
  // 出せなかった理由・条件は、そのまま注意書きへ持っていく（画面だけに出して消さない）。
  for (const w of r.warnings) caveats.push(t(`timi.warn.${w}`));
  if (i.roiFrame == null) caveats.push(t("timi.roi.none"));

  return {
    id: `timi:${i.sopInstanceUid ?? i.seriesUid}:${r.startFrame}:${r.endFrame}`,
    kind: "timi",
    studyUid: i.studyUid,
    seriesUid: i.seriesUid,
    sopInstanceUids: i.sopInstanceUid ? [i.sopInstanceUid] : [],
    frameLabel: t("timi.result.frameNumbers", {
      start: String(r.startFrame + 1),
      end: String(r.endFrame + 1),
    }),
    title: t("xa.task.timi"),
    metrics,
    provenance: [
      { label: t("timi.step.vessel"), value: t(`timi.vessel.${r.vessel}`) },
      {
        label: t("timi.result.rate"),
        value: `${r.fps.toFixed(2)} fps · ${t(`cine.fpsSource.${r.fpsSource}`)}`,
      },
      {
        label: t("timi.result.elapsed"),
        value: r.elapsedMs == null ? "—" : `${r.elapsedMs.toFixed(0)} ms`,
      },
    ],
    caveats,
    at: Date.now(),
  };
}

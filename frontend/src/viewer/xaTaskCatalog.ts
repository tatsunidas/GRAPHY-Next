/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 解析タスクの一覧と「いま開けるか」の判定（`fw/angio-design.md` §21.2・A13-2）。
 *
 * <h3>なぜ一覧が要るか</h3>
 * 解析の入口は現状 **2D ビューアのサイドバーのボタン**しかない。つまり
 * **XA のシリーズをタイルに開くまで、どんな解析があるのかが分からない**。
 * タスクが 1 つ（2D QCA）のうちは問題にならなかったが、QLV・3D QCA が増えて
 * 「何ができるのか」「何がまだ無いのか」が本体のどこにも書かれていない状態になった。
 *
 * <h3>ここで守ること</h3>
 * 1. **未実装のタスクも並べる。** 隠すと「無い」ことが伝わらず、毎回ドキュメントを読む羽目になる。
 *    ただし**押せない理由を必ず出す**（§21.2 の「無言で押せないボタンを並べない」）。
 * 2. **押せない理由は 1 つだけ、重い順に返す。** 「未実装」かつ「スタディ未選択」のときに
 *    「スタディを選べ」と出すと、選んでも状況が変わらず**バグに見える**。
 * 3. **既存の導線を置き換えない。** ここは*追加*の入口で、押すと結局
 *    2D ビューアの同じダイアログが開く（§21.2「守ること」）。判定も実体も二重に持たない。
 *
 * <p>純データ＋純関数（React 非依存）。UI を起動せずに vitest で検査する。
 */

/** タスク識別子。`opens` が指すダイアログの実体は `SeriesViewer` にある。 */
export type AnalysisTaskId =
  | "qca"
  | "qva"
  | "qca3d"
  | "qca3dBifurcation"
  | "qlv"
  | "qlvBiplane"
  | "report";

/** 起動したときに開くもの。`null` は未実装（開くものが無い）。 */
export type AnalysisTaskTarget = "xaAnalysis" | "qva" | "qlv" | "qca3d" | "report";

export interface AnalysisTaskDef {
  id: AnalysisTaskId;
  /** 見出し。 */
  labelKey: string;
  /** 1 行の説明（何が出るか）。 */
  descKey: string;
  /**
   * 実装済みか。**未実装でも一覧には出す**（上記 1）。
   */
  implemented: boolean;
  /** 実装済みならその位置づけ、未実装なら担当フェーズ（`A5a` 等）。文言ではなく識別子。 */
  phase: string;
  /** 何を開くか。未実装は `null`。 */
  opens: AnalysisTaskTarget | null;
  /** XA（フレーム軸を持つ血管撮影）のシリーズが選ばれている必要があるか。 */
  needsXaSeries: boolean;
  /** standalone 専用か（web は A12 未確認）。 */
  standaloneOnly: boolean;
}

/**
 * タスクの一覧。**表示順＝この配列の順**（2D → 3D → LV → 報告書）。
 *
 * <p>名前は参照製品の訳語をそのまま使わず、**GRAPHY の既存用語に合わせる**（§21.2「守ること」）。
 */
export const ANALYSIS_TASKS: readonly AnalysisTaskDef[] = [
  {
    id: "qca",
    labelKey: "xa.task.qca",
    descKey: "xa.task.qca.desc",
    implemented: true,
    phase: "A4",
    opens: "xaAnalysis",
    needsXaSeries: true,
    standaloneOnly: true,
  },
  {
    id: "qva",
    labelKey: "xa.task.qva",
    descKey: "xa.task.qva.desc",
    implemented: true,
    phase: "A5a",
    opens: "qva",
    needsXaSeries: true,
    standaloneOnly: true,
  },
  {
    id: "qca3d",
    labelKey: "xa.task.qca3d",
    descKey: "xa.task.qca3d.desc",
    implemented: true,
    phase: "A6a",
    opens: "qca3d",
    needsXaSeries: true,
    standaloneOnly: true,
  },
  {
    id: "qca3dBifurcation",
    labelKey: "xa.task.qca3dBifurcation",
    descKey: "xa.task.qca3dBifurcation.desc",
    implemented: false,
    phase: "A6b",
    opens: null,
    needsXaSeries: true,
    standaloneOnly: true,
  },
  {
    id: "qlv",
    labelKey: "xa.task.qlv",
    descKey: "xa.task.qlv.desc",
    implemented: true,
    phase: "A5b",
    opens: "qlv",
    needsXaSeries: true,
    standaloneOnly: true,
  },
  {
    id: "qlvBiplane",
    labelKey: "xa.task.qlvBiplane",
    descKey: "xa.task.qlvBiplane.desc",
    implemented: false,
    phase: "A5c",
    opens: null,
    needsXaSeries: true,
    standaloneOnly: true,
  },
  {
    // 🔑 報告書だけは**画像のシリーズを要らない**（スタディに紐づく）。ここだけ経路も違い、
    //    2D ビューアではなくメインウィンドウのレポート編集を開く。
    id: "report",
    labelKey: "xa.task.report",
    descKey: "xa.task.report.desc",
    implemented: true,
    phase: "A14",
    opens: "report",
    needsXaSeries: false,
    standaloneOnly: false,
  },
] as const;

/** 起動側（メインウィンドウ）の状況。**新しい状態を増やさず、MainScreen が既に持つものだけ**。 */
export interface LauncherContext {
  hasStudy: boolean;
  /** 選択中シリーズのモダリティ。未選択なら null。 */
  seriesModality: string | null;
  standalone: boolean;
}

export interface TaskAvailability {
  enabled: boolean;
  /** 押せない理由（i18n キー）。`enabled` のときは undefined。 */
  reasonKey?: string;
  params?: Record<string, string>;
}

/** XA として解析できるモダリティ。`SeriesViewer` の「フレーム軸」判定と同じ範囲。 */
export const XA_MODALITIES: readonly string[] = ["XA", "XRF"];

export function isXaModality(modality: string | null | undefined): boolean {
  return !!modality && XA_MODALITIES.includes(modality.toUpperCase());
}

/**
 * タスクが押せるかと、押せない場合の理由を返す。
 *
 * <p>🚨 **理由は重い順に 1 つだけ**（上記 2）。並べ替えるとユーザの操作が空振りする。
 * 「未実装」→「web では未対応」→「スタディ未選択」→「XA のシリーズが未選択」の順。
 * 最初の 2 つは**ユーザが今すぐ直せない理由**、後ろの 2 つは**直せる理由**なので、
 * 直せない理由を先に出す。
 */
export function taskAvailability(def: AnalysisTaskDef, ctx: LauncherContext): TaskAvailability {
  if (!def.implemented) {
    return { enabled: false, reasonKey: "xa.task.reason.notImplemented", params: { phase: def.phase } };
  }
  if (def.standaloneOnly && !ctx.standalone) {
    return { enabled: false, reasonKey: "xa.task.reason.standaloneOnly" };
  }
  if (!ctx.hasStudy) {
    return { enabled: false, reasonKey: "xa.task.reason.noStudy" };
  }
  if (def.needsXaSeries && !isXaModality(ctx.seriesModality)) {
    return { enabled: false, reasonKey: "xa.task.reason.noXaSeries" };
  }
  return { enabled: true };
}

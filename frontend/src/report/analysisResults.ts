/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 解析結果をレポートへ差し込むための共通表現（`fw/angio-design.md` §21.5 / A14）。
 *
 * <h3>方針</h3>
 * **新しいレポート機構を作らない。** 既存の汎用レポート（`ReportEditorDialog`）の本文は
 * Markdown なので、解析結果を **Markdown のブロック 1 つ**に整形して差し込む。
 *
 * <h3>🚨 数値だけを差し込まない</h3>
 * QCA・QLV・3D QCA のどれも、**同じ数値が条件次第で別の意味を持つ**:
 * - 未校正なら長さは px（QCA）、容積は出せない（QLV）
 * - 手修正が入っていれば自動値ではない
 * - 3D は 2 方向の選び方と角度補正の有無で変わる
 *
 * レポートは SR と違って**人が読んで判断する最終成果物**なので、
 * **出自（校正の経路・手修正・アルゴリズム）と限界を数値と同じブロックに入れる**。
 * SR に書いている内容と食い違わせない（§19）。
 *
 * <p>ここは**純ロジック**（React・i18n 非依存）。文言は呼び出し側が `t()` で解決して渡す。
 */

export type AnalysisKind = "qca" | "qva" | "qlv" | "qca3d";

/** 1 行の計測値。 */
export interface AnalysisMetric {
  /** 表示名（呼び出し側で i18n 済み）。 */
  label: string;
  /** 値の文字列（丸めも呼び出し側の責任。**表示と保存でずれないように**）。 */
  value: string;
  /** 単位。無次元なら省略。 */
  unit?: string;
}

/** 出自の 1 行（校正・手修正・アルゴリズムなど）。 */
export interface AnalysisProvenanceItem {
  label: string;
  value: string;
}

export interface AnalysisResultRecord {
  /** 一覧での識別。同じ解析をやり直したら置き換える鍵にもなる。 */
  id: string;
  kind: AnalysisKind;
  studyUid: string;
  seriesUid: string;
  /** 参照した元インスタンス（複数可。3D QCA は 2 方向ある）。 */
  sopInstanceUids: string[];
  /** 「ラン 3 / フレーム 12」のような人が読む位置。 */
  frameLabel: string;
  /** ブロックの見出し。 */
  title: string;
  metrics: AnalysisMetric[];
  provenance: AnalysisProvenanceItem[];
  /** 限界・注意（i18n 済みの文）。**空にしない**（下記）。 */
  caveats: string[];
  at: number;
}

/**
 * レポート本文へ差し込む Markdown を作る。
 *
 * <h3>🔴 注意書きを空のまま通さない</h3>
 * `caveats` が空の記録は**作らせない**（{@link assertHasCaveats} で検査する）。
 * どの解析にも必ず言うべきことがある —— 少なくとも「研究用であり診断に用いない」。
 * 空の注意書きを許すと、**注意書きを書き忘れた結果が、注意の要らない結果と同じ顔で**
 * レポートに載る。§16.4 の系統誤差（径 13% 過小）がまさにそれで、
 * **MLD/RVD を絶対値で報告書に載せる以上、避けて通れない**。
 */
export function formatAnalysisBlock(r: AnalysisResultRecord, labels: BlockLabels): string {
  const lines: string[] = [];
  lines.push(`## ${r.title}`);
  lines.push("");
  lines.push(`${labels.location}: ${r.frameLabel}`);
  lines.push("");

  if (r.metrics.length > 0) {
    lines.push(`| ${labels.metric} | ${labels.value} |`);
    lines.push("| :- | -: |");
    for (const m of r.metrics) {
      lines.push(`| ${m.label} | ${m.value}${m.unit ? ` ${m.unit}` : ""} |`);
    }
    lines.push("");
  }

  if (r.provenance.length > 0) {
    lines.push(`**${labels.provenance}**`);
    lines.push("");
    for (const p of r.provenance) lines.push(`- ${p.label}: ${p.value}`);
    lines.push("");
  }

  // 注意書きは**最後ではなく計測の直後**に置く。末尾へ追いやると読まれない。
  for (const c of r.caveats) lines.push(`> ${c}`);
  if (r.caveats.length > 0) lines.push("");

  return lines.join("\n");
}

export interface BlockLabels {
  location: string;
  metric: string;
  value: string;
  provenance: string;
}

/**
 * 記録が「レポートに載せてよい形」かを確かめる。
 *
 * <p>作る側の書き忘れを**作った時点で**止めるためのもの（レポートに載ってからでは遅い）。
 */
export function assertHasCaveats(r: AnalysisResultRecord): void {
  if (r.caveats.length === 0) {
    throw new Error(`解析結果 ${r.id} に注意書きがありません（レポートへ載せる記録には必須）`);
  }
}

/**
 * 既存の本文へブロックを足す。
 *
 * <p>⚠️ **本文を置き換えない。** 人が書いた所見を解析結果で上書きするのは、
 * どんな場合でも間違い。常に末尾へ追記し、間に空行を 1 つ入れる。
 */
export function appendBlock(body: string, block: string): string {
  const base = body.replace(/\s+$/, "");
  return base.length === 0 ? block : `${base}\n\n${block}`;
}

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

/**
 * 解析の種別。`plugin` は**プラグインが登録した結果**（host API の H25）。
 *
 * <p>プラグインごとに種別を増やさない: 本体は「どのプラグインか」を
 * {@link AnalysisResultRecord.provenance} の 1 行として持つ（本体が書くので消せない）。
 */
export type AnalysisKind = "qca" | "qlv" | "qca3d" | "plugin";

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
 * レポートに載る。§16.4 の系統誤差（半値法だと径が小さめに出る）がまさにそれで、
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
/**
 * プラグインが渡した解析結果を、レポートへ載せられる記録に仕立てる（host API の H39）。
 *
 * <h3>host が必ず入れるもの（プラグインに任せない）</h3>
 * 1. **id の名前空間**。🔴 登録簿は **id が同じ記録を置き換える**ので、プラグインが本体と同じ
 *    id を出せると**本体の解析結果を差し替えられる**（レポートに載る値が黙って変わる）。
 * 2. **スタディ / シリーズ**。表示中のものを入れる（プラグインに選ばせない）。
 * 3. **出自にプラグイン名と版**。「誰が計算したか」は数値と同じくらい重要。
 * 4. **研究用である旨**。プラグイン側が書き忘れても必ず載る。
 *
 * <h3>それでもプラグインに 1 つ以上の注意書きを要求する</h3>
 * host が研究用の 1 行を足すので、形式上は空でも通せる。それでも**空を拒否する**のは、
 * 「その解析に固有の限界」を書かせるため——半値法の系統誤差・単一投影・未校正など、
 * **数値の意味を変える事情を知っているのはプラグイン側だけ**（§21.5）。
 *
 * @param input     プラグインからの入力（id はプラグイン内でのローカル id）
 * @param context   表示中のスタディ / シリーズ
 * @param producer  プラグインの id / 表示名 / 版
 * @param labels    host が足す文言（i18n 済み）
 * @param now       記録時刻
 * @returns 記録、または拒否理由
 */
export function buildPluginAnalysisRecord(
  input: PluginAnalysisInput,
  context: { studyUid: string; seriesUid: string },
  producer: { id: string; name: string; version: string },
  labels: { pluginLabel: string; researchOnly: string },
  now: number,
): { ok: true; record: AnalysisResultRecord } | { ok: false; error: string } {
  const caveats = (input.caveats ?? []).map((c) => c.trim()).filter((c) => c.length > 0);
  if (caveats.length === 0) {
    return { ok: false, error: "caveats is required (この解析に固有の限界を 1 つ以上入れてください)" };
  }
  if (!input.id || !input.id.trim()) {
    return { ok: false, error: "id is required" };
  }
  if (!labels.researchOnly.trim()) {
    return { ok: false, error: "researchOnly label is empty" };
  }
  const withResearchOnly = caveats.includes(labels.researchOnly)
    ? caveats
    : [...caveats, labels.researchOnly];
  return {
    ok: true,
    record: {
      // 🔴 本体の記録と衝突させない。プラグイン id ごとに名前空間を分ける。
      id: `plugin:${producer.id}:${input.id.trim()}`,
      kind: input.kind,
      studyUid: context.studyUid,
      seriesUid: context.seriesUid,
      sopInstanceUids: [...(input.sopInstanceUids ?? [])],
      frameLabel: input.frameLabel,
      title: input.title,
      metrics: input.metrics.map((m) => ({ ...m })),
      provenance: [
        ...input.provenance.map((p) => ({ ...p })),
        { label: labels.pluginLabel, value: `${producer.name} ${producer.version}`.trim() },
      ],
      caveats: withResearchOnly,
      at: now,
    },
  };
}

/** プラグインからの入力（host が入れる項目は含まない）。 */
export interface PluginAnalysisInput {
  /** プラグイン内でのローカル id。host が名前空間を付ける。 */
  id: string;
  kind: AnalysisKind;
  sopInstanceUids?: string[];
  frameLabel: string;
  title: string;
  metrics: AnalysisMetric[];
  provenance: AnalysisProvenanceItem[];
  /** **1 つ以上必須**（空文字は数えない）。 */
  caveats: string[];
}

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

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * QCA / QVA の**解析状態**の保存形（`fw/angio-design.md` §14.5）。
 *
 * <h3>なぜ要るのか</h3>
 * 保存で保管庫に残るのは **GSPS（絵）と SR（数値）**だけで、どちらも**編集できる解析には
 * 戻せない**。開き直して「解析する」を押すと自動解析からやり直しになり、
 * **中間点・エッジ手修正・区間の切り詰め・健常部の指定が消える**（実機で指摘・2026-08-29）。
 * 数値だけ残っても「あと 1 点だけ直したい」に応えられないので、**やり直せる材料**を残す。
 *
 * <h3>🔴 残すのは「結果」ではなく「入力」</h3>
 * 径や %DS は保存しない（それは SR の仕事）。ここに置くのは**同じ結果をもう一度作るための
 * 入力**——どの計測を使ったか・中間点・エッジ手修正・区間・参照径。結果を持つと、
 * アルゴリズムを直したときに**古い数値が新しい画面に混ざる**。
 *
 * <h3>🔴 エッジ手修正は中心線の指紋つきで持つ</h3>
 * 手修正は**中心線インデックス**で指すので、中心線が変わると別の場所に当たる。
 * `edgeToken`（`qca.centerlineToken`）を一緒に残し、合わなければ `qca.ts` が
 * 手修正を捨てて `edgeEditsDropped` を警告する（既存の仕組みにそのまま乗る）。
 *
 * <h3>保存先</h3>
 * ROI と同じ患者ごとの JSON（`/api/rois`）へ相乗りする。**スキーマ版は上げない**
 * ——`parseSaveFile` は「自分より新しい版は読まない」ので、版を上げると**古いアプリが
 * その患者の ROI を丸ごと空として読む**。追加は「知らないキーは無視される」形に留める
 * （古いアプリが上書き保存すると解析状態だけは失われるが、ROI は無傷）。
 */

import type { QcaReferenceMode } from "./qca";

/** 解析状態 1 件。 */
export interface SavedQcaAnalysis {
  /** 同じ計測・同じフレームに対しては 1 件（{@link analysisId}）。 */
  id: string;
  mode: "qca" | "qva";
  studyUid: string;
  seriesUid: string;
  /** 表示中フレームの元インスタンス（＝ラン）。 */
  sopInstanceUid: string;
  /** フレーム番号（**0 origin**。DICOM へ書くときだけ +1 する）。 */
  frame: number;
  /** 解析区間に使った計測（長さ）の annotationUID。 */
  pickUid: string;
  /** 中心線の指紋。合わなければエッジ手修正は捨てられる。 */
  edgeToken: string | null;
  waypoints: [number, number][];
  /** 中心線（path）インデックス → 法線方向の符号付きオフセット。 */
  edgeEdits: Record<number, { left?: number; right?: number }>;
  trim: { from: number; to: number } | null;
  reference: QcaReferenceMode;
  /**
   * この解析から書いた SR。**上書き保存の対象**を指す。
   * 消えていることもある（利用者が保管庫から消した）ので、使う前に存在を確かめる。
   */
  sr: { seriesInstanceUid: string; sopInstanceUid: string } | null;
  /** 保存時刻（ISO-8601）。同じ id が競合したときは新しい方を採る。 */
  savedAt: string;
}

/** 解析状態を指す鍵。**フレームまで含める**（別フレームは別の解析）。 */
export interface QcaAnalysisKey {
  sopInstanceUid: string;
  frame: number;
  pickUid: string;
  mode: "qca" | "qva";
}

export function analysisId(key: QcaAnalysisKey): string {
  return `${key.sopInstanceUid}#${key.frame}#${key.pickUid}#${key.mode}`;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function sanitizeReference(v: unknown): QcaReferenceMode | null {
  const r = v as { kind?: unknown; ranges?: unknown } | null;
  if (!r || typeof r.kind !== "string") return null;
  if (r.kind === "auto" || r.kind === "ends") return { kind: r.kind };
  if (r.kind === "segments") {
    if (!Array.isArray(r.ranges)) return null;
    const ranges: [number, number][] = [];
    for (const item of r.ranges as unknown[]) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const a = item[0];
      const b = item[1];
      if (!isFiniteNumber(a) || !isFiniteNumber(b)) continue;
      ranges.push([a, b]);
    }
    // 区間が 1 つも残らなければ「健常部の指定」ではない。auto へ落とすより**捨てる**
    //（黙って別の参照径で復元すると %DS が変わる）。
    return ranges.length ? { kind: "segments", ranges } : null;
  }
  return null;
}

function sanitizeEdgeEdits(v: unknown): Record<number, { left?: number; right?: number }> {
  const out: Record<number, { left?: number; right?: number }> = {};
  if (!v || typeof v !== "object") return out;
  for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
    const i = Number(key);
    if (!Number.isInteger(i) || i < 0) continue;
    const e = val as { left?: unknown; right?: unknown } | null;
    if (!e || typeof e !== "object") continue;
    const entry: { left?: number; right?: number } = {};
    // 符号の約束（left < 0 < right）を破る値は入れない。`qca.ts` も同じ検査をするが、
    // 保存の段で落としておくと「復元したのに片側だけ当たらない」を防げる。
    if (isFiniteNumber(e.left) && e.left < 0) entry.left = e.left;
    if (isFiniteNumber(e.right) && e.right > 0) entry.right = e.right;
    if (entry.left !== undefined || entry.right !== undefined) out[i] = entry;
  }
  return out;
}

function sanitizePoints(v: unknown): [number, number][] {
  if (!Array.isArray(v)) return [];
  const out: [number, number][] = [];
  for (const p of v as unknown[]) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = p[0];
    const y = p[1];
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) continue;
    out.push([x, y]);
  }
  return out;
}

/**
 * 保存ファイルの 1 件を読む。**壊れていれば null**（1 件の破損で全部を失わない）。
 */
export function sanitizeAnalysis(v: unknown): SavedQcaAnalysis | null {
  const a = v as Partial<SavedQcaAnalysis> | null;
  if (!a || typeof a !== "object") return null;
  if (typeof a.sopInstanceUid !== "string" || !a.sopInstanceUid) return null;
  if (typeof a.pickUid !== "string" || !a.pickUid) return null;
  if (!isFiniteNumber(a.frame) || a.frame < 0) return null;
  const mode = a.mode === "qva" ? "qva" : "qca";
  const reference = sanitizeReference(a.reference) ?? { kind: "auto" };
  const key: QcaAnalysisKey = {
    sopInstanceUid: a.sopInstanceUid,
    frame: Math.round(a.frame),
    pickUid: a.pickUid,
    mode,
  };
  const sr =
    a.sr && typeof a.sr === "object" &&
    typeof (a.sr as { seriesInstanceUid?: unknown }).seriesInstanceUid === "string" &&
    typeof (a.sr as { sopInstanceUid?: unknown }).sopInstanceUid === "string"
      ? {
          seriesInstanceUid: (a.sr as { seriesInstanceUid: string }).seriesInstanceUid,
          sopInstanceUid: (a.sr as { sopInstanceUid: string }).sopInstanceUid,
        }
      : null;
  return {
    id: typeof a.id === "string" && a.id ? a.id : analysisId(key),
    mode,
    studyUid: typeof a.studyUid === "string" ? a.studyUid : "",
    seriesUid: typeof a.seriesUid === "string" ? a.seriesUid : "",
    sopInstanceUid: key.sopInstanceUid,
    frame: key.frame,
    pickUid: key.pickUid,
    edgeToken: typeof a.edgeToken === "string" ? a.edgeToken : null,
    waypoints: sanitizePoints(a.waypoints),
    edgeEdits: sanitizeEdgeEdits(a.edgeEdits),
    trim:
      a.trim && isFiniteNumber((a.trim as { from?: unknown }).from) && isFiniteNumber((a.trim as { to?: unknown }).to)
        ? { from: (a.trim as { from: number }).from, to: (a.trim as { to: number }).to }
        : null,
    reference,
    sr,
    savedAt: typeof a.savedAt === "string" ? a.savedAt : "",
  };
}

/** 同じ id は差し替える（同じ計測の解析は 1 件だけ持つ）。 */
export function upsertAnalysis(
  list: readonly SavedQcaAnalysis[],
  next: SavedQcaAnalysis,
): SavedQcaAnalysis[] {
  const out = list.filter((a) => a.id !== next.id);
  out.push(next);
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 鍵に一致する解析を探す。 */
export function findAnalysis(
  list: readonly SavedQcaAnalysis[],
  key: QcaAnalysisKey,
): SavedQcaAnalysis | null {
  const id = analysisId(key);
  return list.find((a) => a.id === id) ?? null;
}

/**
 * 2 つの保存内容を混ぜる（別ウィンドウが先に保存したときの再試行用）。
 *
 * <p>同じ id は **`savedAt` が新しい方**を採る。ROI と違い解析は「上書きしていく」ものなので、
 * 和集合ではなく新しい方が正しい。
 */
export function mergeAnalyses(
  remote: readonly SavedQcaAnalysis[],
  local: readonly SavedQcaAnalysis[],
): SavedQcaAnalysis[] {
  const byId = new Map<string, SavedQcaAnalysis>();
  for (const a of remote) byId.set(a.id, a);
  for (const a of local) {
    const cur = byId.get(a.id);
    if (!cur || (a.savedAt || "") >= (cur.savedAt || "")) byId.set(a.id, a);
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * 元の計測が消えた解析を落とす。
 *
 * <p>🔴 計測を消したのに解析状態が残っていると、**次に同じ場所へ引いた別の計測**へ
 * 復元が当たり得る（UID は再利用されないので実際には当たらないが、残骸は増える一方になる）。
 * 墓標に載った UID を鍵に持つものは捨てる。
 */
export function dropAnalysesFor(
  list: readonly SavedQcaAnalysis[],
  buriedRoiUids: Iterable<string>,
): SavedQcaAnalysis[] {
  const buried = new Set(buriedRoiUids);
  if (!buried.size) return [...list];
  return list.filter((a) => !buried.has(a.pickUid));
}

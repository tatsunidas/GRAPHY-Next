/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ハンギングプロトコル（検査を開いたとき、シリーズをどのタイルにどの順で並べるかの規則）の、形の検証・照合・配置。
 *
 * <p>**純関数だけ**。React・Cornerstone・fetch に依存せず、ピクセルにも画面にも触れない（UI・保存・適用は別の段）。
 * 入力はシリーズ一覧（`modality`・`seriesDescription`・`seriesNumber`）と検査（`studyDescription`・`modality`）で、
 * 出力は「配列の順のシリーズ UID と、行数・列数」。2D ビューアのタイルは**配列の順がそのまま行優先のセルの順**なので、
 * 配置の結果はその順で返す。
 *
 * <p>**決定的**: 入力の配列の順に依存しない（候補は `seriesNumber`→説明→UID の順に並べ直す。複数のプロトコルは条件の数・
 * 埋まる数・名前・id で順位を決める）。照合の文字列は {@link normalizeText}（NFKC・ゼロ幅文字の除去・空白の圧縮・小文字化）を通す。
 * ただし「T1」と「T1W」のような**表記の違いは吸収しない**（利用者が規則に書く）。
 *
 * <p>ボディパート・左右は、シリーズ一覧に無いので対象外。
 */

export type HangingPick = "first" | "last" | "all";

export interface HangingSeriesRule {
  modality?: string;
  descriptionContains?: string;
  numberEquals?: number;
  pick?: HangingPick;
}

export interface HangingMatch {
  modality?: string[];
  studyDescriptionContains?: string;
}

export interface HangingGrid {
  /** 0＝自動。 */
  rows: number;
  cols: number;
}

export interface HangingProtocol {
  id: string;
  name: string;
  version: 1;
  match: HangingMatch;
  slots: { series: HangingSeriesRule }[];
  grid: HangingGrid;
  /** 窓が縦長のときの配置。未指定なら `grid`。 */
  gridPortrait?: HangingGrid;
  /** 知らないトップレベルのキー。読み飛ばさず保持し、書き戻す（将来の拡張・他の版との往復で失わない）。 */
  extra: Record<string, unknown>;
}

export type ParseResult = { ok: true; protocol: HangingProtocol } | { ok: false; errors: string[] };

export interface SeriesLike {
  seriesInstanceUid: string;
  modality?: string | null;
  seriesNumber?: number | null;
  seriesDescription?: string | null;
}

export interface StudyLike {
  modality?: string | null;
  modalities?: string[] | null;
  studyDescription?: string | null;
}

export const MAX_SLOTS = 24;
export const MAX_TEXT = 100;
export const MAX_GRID = 12;
/** 設定の 1 値の上限（`app_setting.setting_value` は 4000 文字）。 */
export const MAX_STORED_CHARS = 4000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const KNOWN_KEYS = new Set(["id", "name", "version", "match", "slots", "grid", "gridPortrait"]);

/** NFKC → ゼロ幅文字の除去 → 連続する空白を 1 つに → 前後の空白の除去 → 小文字化。 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[​-‍﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 検証。壊れた入力は例外にせず、場所つきの理由を返す。未知のトップレベルのキーは `extra` に保持する。 */
export function parseHangingProtocol(raw: unknown): ParseResult {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["全体: オブジェクトではありません"] };

  const text = (v: unknown, path: string, opts: { allowEmpty?: boolean } = {}): string | undefined => {
    if (typeof v !== "string") {
      errors.push(`${path}: 文字列ではありません`);
      return undefined;
    }
    if (v.length > MAX_TEXT) errors.push(`${path}: ${MAX_TEXT} 文字を超えています`);
    if (!opts.allowEmpty && normalizeText(v) === "") errors.push(`${path}: 空です`);
    return v;
  };

  if (raw.version !== 1) errors.push(`version: 1 のみ対応しています（受け取った値: ${JSON.stringify(raw.version)}）`);
  const id = text(raw.id, "id");
  if (typeof id === "string" && !ID_PATTERN.test(id)) errors.push("id: 半角英数字・「_」「-」の 1〜40 文字にしてください");
  const name = text(raw.name, "name");

  // match
  const match: HangingMatch = {};
  if (raw.match !== undefined) {
    if (!isObject(raw.match)) errors.push("match: オブジェクトではありません");
    else {
      const m = raw.match;
      if (m.modality !== undefined) {
        if (!Array.isArray(m.modality) || m.modality.length < 1 || m.modality.length > 10) errors.push("match.modality: 1〜10 個の文字列の配列にしてください");
        else {
          const mods = m.modality.map((x, i) => text(x, `match.modality[${i}]`));
          if (mods.every((x) => typeof x === "string")) match.modality = mods as string[];
        }
      }
      if (m.studyDescriptionContains !== undefined) {
        const s = text(m.studyDescriptionContains, "match.studyDescriptionContains");
        if (s !== undefined) match.studyDescriptionContains = s;
      }
    }
  }

  // slots
  const slots: HangingProtocol["slots"] = [];
  if (!Array.isArray(raw.slots) || raw.slots.length < 1) errors.push("slots: 1 個以上の配列にしてください");
  else if (raw.slots.length > MAX_SLOTS) errors.push(`slots: ${MAX_SLOTS} 個までです（${raw.slots.length} 個）`);
  else {
    raw.slots.forEach((slot, i) => {
      const base = `slots[${i}].series`;
      if (!isObject(slot) || !isObject(slot.series)) {
        errors.push(`${base}: オブジェクトではありません`);
        return;
      }
      const s = slot.series;
      const rule: HangingSeriesRule = {};
      if (s.modality !== undefined) {
        const v = text(s.modality, `${base}.modality`);
        if (v !== undefined) rule.modality = v;
      }
      if (s.descriptionContains !== undefined) {
        const v = text(s.descriptionContains, `${base}.descriptionContains`);
        if (v !== undefined) rule.descriptionContains = v;
      }
      if (s.numberEquals !== undefined) {
        if (typeof s.numberEquals !== "number" || !Number.isInteger(s.numberEquals)) errors.push(`${base}.numberEquals: 整数ではありません`);
        else rule.numberEquals = s.numberEquals;
      }
      if (s.pick !== undefined) {
        if (s.pick !== "first" && s.pick !== "last" && s.pick !== "all") errors.push(`${base}.pick: "first"・"last"・"all" のどれかです`);
        else rule.pick = s.pick;
      }
      if (s.modality === undefined && s.descriptionContains === undefined && s.numberEquals === undefined) {
        errors.push(`${base}: 条件が空です（modality・descriptionContains・numberEquals のどれかが要ります）`);
      }
      slots.push({ series: rule });
    });
  }

  const grid = parseGrid(raw.grid, "grid", errors, true);
  const gridPortrait = raw.gridPortrait === undefined ? undefined : parseGrid(raw.gridPortrait, "gridPortrait", errors, false);

  if (errors.length > 0 || typeof id !== "string" || typeof name !== "string" || !grid) return { ok: false, errors: errors.length ? errors : ["全体: 不正です"] };

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!KNOWN_KEYS.has(k)) extra[k] = v;
  const protocol: HangingProtocol = { id, name, version: 1, match, slots, grid, extra };
  if (gridPortrait) protocol.gridPortrait = gridPortrait;
  return { ok: true, protocol };
}

function parseGrid(v: unknown, path: string, errors: string[], required: boolean): HangingGrid | undefined {
  if (v === undefined) {
    if (required) errors.push(`${path}: 必要です`);
    return undefined;
  }
  if (!isObject(v)) {
    errors.push(`${path}: オブジェクトではありません`);
    return undefined;
  }
  let ok = true;
  for (const k of ["rows", "cols"] as const) {
    const n = v[k];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_GRID) {
      errors.push(`${path}.${k}: 0〜${MAX_GRID} の整数にしてください（0＝自動）`);
      ok = false;
    }
  }
  return ok ? { rows: v.rows as number, cols: v.cols as number } : undefined;
}

/** JSON 文字列に。`extra` も書き戻す。 */
export function serializeHangingProtocol(p: HangingProtocol): string {
  const out: Record<string, unknown> = { version: p.version, id: p.id, name: p.name, match: p.match, slots: p.slots, grid: p.grid };
  if (p.gridPortrait) out.gridPortrait = p.gridPortrait;
  return JSON.stringify({ ...out, ...p.extra });
}

/** 保存できるか（設定の 1 値は 4000 文字まで）。できなければ理由を返す。 */
export function checkStorable(p: HangingProtocol): string | null {
  const n = serializeHangingProtocol(p).length;
  return n > MAX_STORED_CHARS ? `大きすぎて保存できません（${n} 文字。上限は ${MAX_STORED_CHARS} 文字）` : null;
}

// ---- 照合・配置 ----

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 候補の並び: seriesNumber の昇順（null は末尾）→ seriesDescription → UID。入力の順に依存しない。 */
function compareSeries(a: SeriesLike, b: SeriesLike): number {
  const an = a.seriesNumber ?? Number.POSITIVE_INFINITY;
  const bn = b.seriesNumber ?? Number.POSITIVE_INFINITY;
  if (an !== bn) return an < bn ? -1 : 1;
  return cmp(a.seriesDescription ?? "", b.seriesDescription ?? "") || cmp(a.seriesInstanceUid, b.seriesInstanceUid);
}

function seriesMatchesRule(s: SeriesLike, rule: HangingSeriesRule): boolean {
  if (rule.modality !== undefined) {
    if (s.modality == null || normalizeText(s.modality) !== normalizeText(rule.modality)) return false;
  }
  if (rule.descriptionContains !== undefined) {
    if (s.seriesDescription == null || !normalizeText(s.seriesDescription).includes(normalizeText(rule.descriptionContains))) return false;
  }
  if (rule.numberEquals !== undefined) {
    if (s.seriesNumber == null || s.seriesNumber !== rule.numberEquals) return false;
  }
  return true;
}

export interface Arrangement {
  /** 配列の順（＝行優先のセルの順）のシリーズ UID。埋まらなかったスロットは詰めてある。 */
  seriesUids: string[];
  rows: number;
  cols: number;
  /** 埋まらなかったスロットの添字。 */
  unfilledSlots: number[];
}

export function arrange(protocol: HangingProtocol, seriesList: readonly SeriesLike[], opts: { portrait: boolean }): Arrangement {
  const sorted = [...seriesList].sort(compareSeries);
  const used = new Set<string>();
  const seriesUids: string[] = [];
  const unfilledSlots: number[] = [];
  protocol.slots.forEach((slot, i) => {
    const rule = slot.series;
    const candidates = sorted.filter((s) => !used.has(s.seriesInstanceUid) && seriesMatchesRule(s, rule));
    if (candidates.length === 0) {
      unfilledSlots.push(i);
      return;
    }
    const picked = rule.pick === "all" ? candidates : rule.pick === "last" ? [candidates[candidates.length - 1]] : [candidates[0]];
    for (const s of picked) {
      used.add(s.seriesInstanceUid);
      seriesUids.push(s.seriesInstanceUid);
    }
  });
  const g = opts.portrait && protocol.gridPortrait ? protocol.gridPortrait : protocol.grid;
  return { seriesUids, rows: g.rows, cols: g.cols, unfilledSlots };
}

function studyModalities(study: StudyLike): string[] {
  const list = study.modalities && study.modalities.length > 0 ? study.modalities : study.modality ? [study.modality] : [];
  return list.map(normalizeText);
}

/** 指定された `match` の条件の数。 */
function conditionCount(p: HangingProtocol): number {
  return (p.match.modality ? 1 : 0) + (p.match.studyDescriptionContains !== undefined ? 1 : 0);
}

/** `match` の指定された条件が、検査についてすべて成り立つか（スロットが埋まるかは見ない）。 */
export function studyMeetsMatch(protocol: HangingProtocol, study: StudyLike): boolean {
  const { modality, studyDescriptionContains } = protocol.match;
  if (modality) {
    const mods = studyModalities(study);
    if (!modality.some((m) => mods.includes(normalizeText(m)))) return false;
  }
  if (studyDescriptionContains !== undefined) {
    if (study.studyDescription == null) return false;
    if (!normalizeText(study.studyDescription).includes(normalizeText(studyDescriptionContains))) return false;
  }
  return true;
}

/**
 * 検査に合うプロトコルを 1 つ選ぶ。`match` の指定された条件がすべて成り立ち、かつ**少なくとも 1 つのスロットが埋まる**ものが候補。
 * 順位: 指定された条件の数が多い → 埋まるスロットが多い → name → id（入力の順に依存しない）。合うものが無ければ null。
 */
export function matchProtocol(protocols: readonly HangingProtocol[], study: StudyLike, seriesList: readonly SeriesLike[]): HangingProtocol | null {
  const scored: { p: HangingProtocol; conds: number; filled: number }[] = [];
  for (const p of protocols) {
    if (!studyMeetsMatch(p, study)) continue;
    const a = arrange(p, seriesList, { portrait: false });
    const filled = p.slots.length - a.unfilledSlots.length;
    if (filled < 1) continue;
    scored.push({ p, conds: conditionCount(p), filled });
  }
  if (scored.length === 0) return null;
  scored.sort((x, y) => y.conds - x.conds || y.filled - x.filled || cmp(x.p.name, y.p.name) || cmp(x.p.id, y.p.id));
  return scored[0].p;
}

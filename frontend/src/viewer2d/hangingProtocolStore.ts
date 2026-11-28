/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ハンギングプロトコルの保存・取り込み・書き出しと、自動適用の判定。**純関数だけ**（通信は呼び出し側）。
 *
 * <p>置き場所は backend の設定ストア（`/api/settings`）に `hanging.protocol.<id>` の 1 キー 1 件（`mainscreen/savedSearch.ts` と
 * 同じ形）。値の列が 4000 文字までなので 1 件ずつ分ける。設定ストアに削除 API が無いので、削除は空文字で上書きし、
 * 読む側は空を「無い」として扱う。
 *
 * <p>🚨 設定ストアは全キーを API で読め（プラグインからも）、web ではサーバー共有。
 */
import { planHanging, type HangingPlan, type HangingPlanSeries } from "./hangingApply";
import {
  checkStorable,
  matchProtocol,
  parseHangingProtocol,
  serializeHangingProtocol,
  studyMeetsMatch,
  type HangingProtocol,
  type StudyLike,
} from "./hangingProtocol";
import { classifySeriesRenderability } from "../viewer/seriesRenderable";

export const HANGING_PREFIX = "hanging.protocol.";
/** 検査だけを開いたときに自動で適用するか。値は "true" / "false"。未設定は切。 */
export const HANGING_AUTO_APPLY_KEY = "viewer.hangingAutoApply";

export const isAutoApplyOn = (settings: Record<string, string>): boolean => settings[HANGING_AUTO_APPLY_KEY] === "true";

export interface BrokenProtocol {
  key: string;
  errors: string[];
}

const byName = (a: HangingProtocol, b: HangingProtocol) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function parseText(text: string): { ok: true; raw: unknown } | { ok: false; detail: string } {
  try {
    return { ok: true, raw: JSON.parse(text) as unknown };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** 設定の全キーから保存済みのプロトコルを取り出す。読めないものは黙って捨てず、理由つきで返す（空文字は削除済み）。 */
export function extractProtocols(settings: Record<string, string>): { items: HangingProtocol[]; broken: BrokenProtocol[] } {
  const items: HangingProtocol[] = [];
  const broken: BrokenProtocol[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(HANGING_PREFIX) || value === "") continue;
    const text = parseText(value);
    if (!text.ok) {
      broken.push({ key, errors: [text.detail] });
      continue;
    }
    const parsed = parseHangingProtocol(text.raw);
    if (!parsed.ok) broken.push({ key, errors: parsed.errors });
    else if (HANGING_PREFIX + parsed.protocol.id !== key) {
      // id と鍵が食い違うと、編集や削除が別の項目に当たる。
      broken.push({ key, errors: [`id: 保存キーと一致しません（${parsed.protocol.id}）`] });
    } else items.push(parsed.protocol);
  }
  items.sort(byName);
  broken.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { items, broken };
}

/** その id の保存がすでにあるか（読めないものも「ある」。黙って上書きしない）。 */
export const hasStored = (settings: Record<string, string>, id: string): boolean => (settings[HANGING_PREFIX + id] ?? "") !== "";

export type StoreUpdate = { ok: true; key: string; value: string } | { ok: false; error: string };

export function toStoreUpdate(p: HangingProtocol): StoreUpdate {
  const tooBig = checkStorable(p);
  return tooBig ? { ok: false, error: tooBig } : { ok: true, key: HANGING_PREFIX + p.id, value: serializeHangingProtocol(p) };
}

export type ImportEntry =
  | { index: number; ok: true; protocol: HangingProtocol; key: string; value: string }
  | { index: number; ok: false; errors: string[] };

export type ImportParse = { ok: true; entries: ImportEntry[] } | { ok: false; detail: string };

/** 取り込むファイルの中身（1 件、または配列）を 1 件ずつ検証する。同じ id は 2 件目以降を拒否する。 */
export function parseImport(text: string): ImportParse {
  const json = parseText(text);
  if (!json.ok) return json;
  const list = Array.isArray(json.raw) ? json.raw : [json.raw];
  const seen = new Set<string>();
  const entries = list.map((raw, index): ImportEntry => {
    const parsed = parseHangingProtocol(raw);
    if (!parsed.ok) return { index, ok: false, errors: parsed.errors };
    const update = toStoreUpdate(parsed.protocol);
    if (!update.ok) return { index, ok: false, errors: [update.error] };
    if (seen.has(parsed.protocol.id)) return { index, ok: false, errors: [`id: ファイル内で重複しています（${parsed.protocol.id}）`] };
    seen.add(parsed.protocol.id);
    return { index, ok: true, protocol: parsed.protocol, key: update.key, value: update.value };
  });
  return { ok: true, entries };
}

export function exportProtocols(items: readonly HangingProtocol[]): string {
  return JSON.stringify(items.map((p) => JSON.parse(serializeHangingProtocol(p)) as unknown), null, 2) + "\n";
}

/** 選択欄の並び: 検査の `match` に合うものを先頭、その中は名前順。 */
export function sortForStudy(items: readonly HangingProtocol[], study: StudyLike): HangingProtocol[] {
  return [...items].sort((a, b) => Number(studyMeetsMatch(b, study)) - Number(studyMeetsMatch(a, study)) || byName(a, b));
}

/** 自動適用で使うプロトコルと、その並び。合うものが無ければ null。 */
export function chooseAutoProtocol<S extends HangingPlanSeries>(
  protocols: readonly HangingProtocol[],
  study: StudyLike,
  seriesList: readonly S[],
  opts: { portrait: boolean },
): { protocol: HangingProtocol; plan: Extract<HangingPlan<S>, { ok: true }> } | null {
  // 非画像だけが条件に合うプロトコルを選ばないよう、順位を決める前に外す。
  const images = seriesList.filter(
    (s) => classifySeriesRenderability({ sopClassUid: s.sopClassUid ?? null, modality: s.modality ?? null }).renderable,
  );
  const protocol = matchProtocol(protocols, study, images);
  if (!protocol) return null;
  const plan = planHanging(protocol, study, seriesList, opts);
  return plan.ok ? { protocol, plan } : null;
}

/**
 * 自動適用してよい状態か。**何も失わないときだけ**行う: その患者のタイルが無く、全患者の表示では他の患者もいないとき。
 */
export function autoApplyDecision(
  openPatientKeys: readonly string[],
  patientKey: string,
  isGlobal: boolean,
): "apply" | "has-tiles" | "other-patients" {
  if (openPatientKeys.includes(patientKey)) return "has-tiles";
  return isGlobal && openPatientKeys.length > 0 ? "other-patients" : "apply";
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 一括抽出・ROI 特徴量の「詳細設定（上級者向け）」: RadiomicsJ の設定キーを `KEY=値` で 1 行 1 項目に書く欄の解析と検査。
 *
 * 他の欄が決めるキー（離散化・リサンプリング・範囲・族のオン／オフ・画像フィルタ・値の種類が決める IVH のモードと丸め・
 * backend が必ず上書きするもの）は、ここでは**受け付けない**（同じ設定が 2 か所にあると、どちらが効くかが分からなくなる）。
 * キーが RadiomicsJ に無いものは、backend が実行時に断る。画面では、backend が返すスキーマがあれば入力中に分かる。
 */

import { ROI_FEATURE_FAMILIES } from "./roiFeatureSettings";

/** backend `GET /api/radiomics/features/settings-schema` の 1 項目。 */
export interface SettingSchemaEntry {
  key: string;
  type: "boolean" | "int" | "long" | "double" | "array" | "string";
  /** RadiomicsJ の既定値。既定を持たない（null の）ものは空文字、読み出し方が無いキーは null。 */
  defaultValue: string | null;
}

/** 他の欄が決めるキーと、その欄の名前（拒否の理由に出す）。 */
export type ManagedGroup = "discretisation" | "resampling" | "range" | "family" | "filter" | "valueKind" | "backend";

/**
 * 他の欄が決めるキー → その欄。`roiFeatureSettings.ts` と循環して読み込むので、モジュールの評価時ではなく最初に使うときに作る。
 */
let managed: ReadonlyMap<string, ManagedGroup> | null = null;
export function managedKeys(): ReadonlyMap<string, ManagedGroup> {
  if (!managed) {
    const groups: [group: ManagedGroup, keys: string[]][] = [
      ["discretisation", ["BOOL_USE_FixedBinNumber", "INT_binCount", "DOUBLE_binWidth"]],
      ["resampling", ["DOUBLEARRAY_resamplingFactorXYZ"]],
      ["range", ["DOUBLE_rangeMin", "DOUBLE_rangeMax"]],
      ["family", ROI_FEATURE_FAMILIES.map((f) => f.setting)],
      ["filter", ["DOUBLEARRAY_logSigmaMm", "DOUBLE_logTruncate", "STRING_logPadding"]],
      ["valueKind", ["INT_IVH_MODE", "DOUBLE_IVH_binWidth", "BOOL_interpolation_intensity_rounding"]],
      ["backend", ["INT_label", "BOOL_force2D", "BOOL_enableOperationalInfo", "BOOL_enableDiagnostics"]],
    ];
    managed = new Map(groups.flatMap(([g, keys]) => keys.map((k) => [k, g] as const)));
  }
  return managed;
}

export type AdvancedErrorCode = "format" | "duplicate" | "managed" | "unknown" | "value";

export interface AdvancedError {
  /** 1 始まりの行番号。 */
  line: number;
  key: string;
  code: AdvancedErrorCode;
  /** `managed` のときはその欄の名前（ManagedGroup）、`value` のときは期待する型。 */
  detail?: string;
}

export interface AdvancedParse {
  /** 検査を通った項目（キーの昇順で並べる必要は無い。正準化は定義側）。 */
  entries: Record<string, string>;
  errors: AdvancedError[];
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const MAX_ENTRIES = 100;
const MAX_VALUE_LEN = 200;

/** 値が型に合うか。配列はカンマ区切りの数。BOOL は 0/1/true/false。 */
export function valueMatches(type: SettingSchemaEntry["type"], v: string): boolean {
  const num = (s: string) => s.trim() !== "" && Number.isFinite(Number(s));
  switch (type) {
    case "boolean": return /^(0|1|true|false)$/i.test(v);
    case "int":
    case "long": return /^[+-]?\d+$/.test(v);
    case "double": return num(v);
    case "array": return v.split(",").every((x) => num(x));
    case "string": return v.length > 0;
  }
}

/**
 * `KEY=値` を 1 行 1 項目で読む。空行と `#`・`!` で始まる行は読み飛ばす。
 * `schema` があれば、知らないキーと値の型も検査する（無ければ形・重複・他の欄のキーだけ）。
 */
export function parseAdvanced(text: string, schema?: readonly SettingSchemaEntry[]): AdvancedParse {
  const entries: Record<string, string> = {};
  const errors: AdvancedError[] = [];
  const byKey = schema ? new Map(schema.map((e) => [e.key, e])) : null;
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) return;
    const eq = line.indexOf("=");
    const key = eq < 0 ? line : line.slice(0, eq).trim();
    const value = eq < 0 ? "" : line.slice(eq + 1).trim();
    const at = i + 1;
    if (eq < 0 || !KEY_RE.test(key) || value === "" || value.length > MAX_VALUE_LEN) {
      errors.push({ line: at, key, code: "format" });
      return;
    }
    if (seen.has(key)) {
      errors.push({ line: at, key, code: "duplicate" });
      return;
    }
    seen.add(key);
    const group = managedKeys().get(key);
    if (group) {
      errors.push({ line: at, key, code: "managed", detail: group });
      return;
    }
    if (byKey) {
      const e = byKey.get(key);
      if (!e) {
        errors.push({ line: at, key, code: "unknown" });
        return;
      }
      if (!valueMatches(e.type, value)) {
        errors.push({ line: at, key, code: "value", detail: e.type });
        return;
      }
    }
    entries[key] = value;
  });
  if (Object.keys(entries).length > MAX_ENTRIES) errors.push({ line: 0, key: "", code: "format", detail: "too-many" });
  return { entries, errors };
}

/** 項目を `KEY=値` の行にする（キーの昇順）。 */
export function advancedToText(entries: Readonly<Record<string, string>>): string {
  return Object.keys(entries).sort().map((k) => `${k}=${entries[k]}`).join("\n");
}

export const ADVANCED_MAX_ENTRIES = MAX_ENTRIES;
export const ADVANCED_MAX_VALUE_LEN = MAX_VALUE_LEN;

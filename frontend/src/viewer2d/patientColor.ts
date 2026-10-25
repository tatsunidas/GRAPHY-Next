/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 患者ごとの色（患者の取り違え防止）。
 *
 * - ハッシュではなく**出現順**に割り当てる（ハッシュだと別の患者が同じ色になりうる）。
 * - 表示中の間は色を変えない。患者を閉じたら、その色は次の患者に使い回せる。
 * - 同期の枠（青い outline）と選択の枠（橙の影）に使っている色相は避ける。色だけに頼らないよう、
 *   タイルのヘッダには患者名の頭文字も出す（呼び出し側）。
 */
export interface PatientColor {
  /** 枠・バッジの色。 */
  solid: string;
  /** ヘッダの背景（淡い）。 */
  tint: string;
  /** solid の上に載せる文字色。 */
  onSolid: string;
}

export const PATIENT_PALETTE: readonly PatientColor[] = [
  { solid: "#009E73", tint: "#e3f4ee", onSolid: "#1a1a1a" }, // 緑
  { solid: "#CC79A7", tint: "#f8e8f0", onSolid: "#1a1a1a" }, // ピンク
  { solid: "#7A5BC8", tint: "#ece7f8", onSolid: "#ffffff" }, // 紫
  { solid: "#D55E00", tint: "#f9e6d9", onSolid: "#1a1a1a" }, // 朱
  { solid: "#56B4E9", tint: "#e1f1fb", onSolid: "#1a1a1a" }, // 空
  { solid: "#B8A100", tint: "#f5f1d2", onSolid: "#1a1a1a" }, // 黄土
  { solid: "#8C564B", tint: "#efe5e2", onSolid: "#ffffff" }, // 茶
  { solid: "#5F6B7A", tint: "#e7eaee", onSolid: "#ffffff" }, // 灰
];

/** 患者の鍵 → パレットの番号。 */
export type PatientColorMap = ReadonlyMap<string, number>;

/**
 * 現在表示中の患者（出現順）に色の番号を割り当てる。前回の割り当てに残っている患者は番号を変えず、
 * 新しい患者には使われていない最小の番号を与える。全部使われていれば、使用数が最も少ない番号を使い回す。
 */
export function assignPatientColors(prev: PatientColorMap, keys: readonly string[]): Map<string, number> {
  const next = new Map<string, number>();
  const used = new Array<number>(PATIENT_PALETTE.length).fill(0);
  for (const k of keys) {
    const i = prev.get(k);
    if (i !== undefined && !next.has(k)) {
      next.set(k, i);
      used[i]++;
    }
  }
  for (const k of keys) {
    if (next.has(k)) continue;
    let pick = used.findIndex((n) => n === 0);
    if (pick < 0) pick = used.indexOf(Math.min(...used));
    next.set(k, pick);
    used[pick]++;
  }
  return next;
}

export function patientColorOf(map: PatientColorMap, key: string): PatientColor {
  return PATIENT_PALETTE[map.get(key) ?? 0];
}

/** ヘッダのバッジに出す頭文字（色だけに頼らないため）。取れなければ「?」。 */
export function patientInitial(name: string | null | undefined, id: string | null | undefined): string {
  const src = (name || id || "").trim();
  return src ? [...src][0].toUpperCase() : "?";
}

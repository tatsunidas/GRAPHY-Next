/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 環境設定 ＞ 施設の資料の表示用の純関数（画面から切り離してテストする）。検査は backend の FacilityConfigParser が正本。

/** backend の施設の資料の内容（検証を通した構造。`GET /api/facility/config`）。 */
export interface FacilityItem {
  id: string;
  type: "link" | "card";
  title: string;
  url: string | null;
  note: string | null;
  body: string | null;
}

export interface FacilityGroup {
  id: string;
  title: string;
  items: FacilityItem[];
  groups: FacilityGroup[];
}

export interface FacilityConfig {
  title: string | null;
  updatedAt: string | null;
  contact: string | null;
  groups: FacilityGroup[];
}

/** state: missing / ok / error（未設定は 204 で本文なし）。source: server / setting。 */
export interface FacilityResponse {
  state: "missing" | "ok" | "error";
  error: string | null;
  errorPath: string | null;
  lastReadAt: number | null;
  rev: number;
  source: "server" | "setting" | "none";
  config: FacilityConfig | null;
}

/** グループ・項目の合計数（入れ子を含む）。 */
export function countFacility(c: FacilityConfig | null): { groups: number; items: number } {
  let groups = 0;
  let items = 0;
  const walk = (gs: FacilityGroup[]) => {
    for (const g of gs) {
      groups++;
      items += g.items.length;
      walk(g.groups);
    }
  };
  if (c) walk(c.groups);
  return { groups, items };
}

const ERROR_CODES = [
  "parse",
  "schema",
  "schema-version",
  "limit",
  "url",
  "id-duplicate",
  "not-a-file",
  "extension-not-allowed",
  "file-too-large",
  "decode-failed",
  "read-failed",
  "path-unreadable",
  "file-missing",
];

/** 理由のコード → 文言のキー。知らないコードは汎用の文言（コードをそのまま画面に出さない）。 */
export function facilityErrorKey(code: string | null | undefined): string {
  return code && ERROR_CODES.includes(code) ? `facility.err.${code}` : "facility.err.unknown";
}

/** 設定のパスを画面から変えられるか: デスクトップ（standalone）で、サーバー側の設定が無いとき。 */
export function canEditPath(mode: string | undefined, source: FacilityResponse["source"] | "none"): boolean {
  return mode === "standalone" && source !== "server";
}

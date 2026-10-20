/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ プラグイン ＞ 見つける の表示ロジック（画面と試験が同じ関数を使う）。
 *
 * 索引は「見つけるための一覧」で、安全の根拠にしない。区分（同梱・公式・コミュニティ）は索引の記載ではなく
 * 台帳の値（導入済み）と、本体の信頼する鍵との一致（未導入）から決める。
 */
import type { CatalogItem, PluginPreview } from "../plugins/pluginManagerApi";

/** bundled=同梱（既定で導入済み） / official=当社署名 / community=それ以外 */
export type Tier = "bundled" | "official" | "community";

export interface CatalogRow {
  item: CatalogItem;
  tier: Tier;
  /** 公式と断定してよいか。導入済みで台帳の trust が verified のときだけ true（未導入は「公式鍵の記載がある」止まり）。 */
  officialConfirmed: boolean;
}

export function toRow(item: CatalogItem): CatalogRow {
  const inst = item.installed;
  if (inst?.sourceType === "bundled") return { item, tier: "bundled", officialConfirmed: inst.trust === "verified" };
  if (inst) {
    const verified = inst.trust === "verified";
    return { item, tier: verified ? "official" : "community", officialConfirmed: verified };
  }
  return { item, tier: item.officialSigner ? "official" : "community", officialConfirmed: false };
}

export interface CatalogFilter {
  query: string;
  tier: Tier | "all";
}

/** 検索語は id・名前・説明・repo に部分一致（大文字小文字を区別しない）。 */
export function filterRows(rows: CatalogRow[], f: CatalogFilter): CatalogRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.tier !== "all" && r.tier !== f.tier) return false;
    if (q === "") return true;
    const { id, name, description, repo } = r.item;
    return [id, name, description ?? "", repo].some((s) => s.toLowerCase().includes(q));
  });
}

export type CatalogMismatch = "idMismatch" | "keyMismatch" | "notTrusted";

/**
 * 一覧から導入するとき、導入前検査（inspect）の結果が索引の記載と食い違っていないか調べる。
 * 食い違えば同意画面へ進めない（索引の誤り・差し替え・署名の剥がしを導入前に止める）。
 *
 * - id: 索引は `owner/repo` を指しているだけなので、中身の plugin.json の id と合うか。
 * - 鍵: 索引に鍵 ID があるなら、実際の署名の鍵 ID と一致するか（無署名・別の鍵は不一致）。
 * - 公式: 索引が本体の信頼する鍵を名乗るなら、署名が `trusted` で検証できているか。
 */
export function checkAgainstEntry(item: CatalogItem, preview: PluginPreview): CatalogMismatch | null {
  if (preview.id !== item.id) return "idMismatch";
  if (item.signerKeyId) {
    const actual = preview.signerKeyId?.toUpperCase() ?? null;
    if (actual !== item.signerKeyId.toUpperCase()) return "keyMismatch";
  }
  if (item.officialSigner && preview.signature !== "trusted") return "notTrusted";
  return null;
}

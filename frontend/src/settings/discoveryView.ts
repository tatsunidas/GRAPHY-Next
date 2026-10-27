/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { DiscoveredDevice } from "../api";

/** リモート AE の編集行（RemoteAePanel の Row と同じ形）。 */
export type AeRow = { aeTitle: string; host: string; port: string; tls: boolean };

/**
 * 画面に出す、検出した機器 1 台。同じ機器が複数の NIC（有線・無線）で見えると、アドレスだけが違う複数の結果になるので、
 * AE タイトル・ポート・TLS が同じものを 1 台にまとめ、到達先のアドレスを並べる。
 */
export type DiscoveredItem = {
  aeTitle: string;
  /** TXT に aet が無く、サービス名を AE タイトルの候補にしたもの（確かめてから追加する）。 */
  aeTitleFromName: boolean;
  hosts: string[];
  port: number;
  tls: boolean;
  tlsPort: number;
};

export function groupDiscovered(found: DiscoveredDevice[]): DiscoveredItem[] {
  const items = new Map<string, DiscoveredItem>();
  for (const f of found) {
    const key = `${f.aeTitle}\t${f.port}\t${f.tls ? f.tlsPort : 0}`;
    const cur = items.get(key);
    if (cur) {
      if (!cur.hosts.includes(f.host)) cur.hosts.push(f.host);
    } else {
      items.set(key, {
        aeTitle: f.aeTitle,
        aeTitleFromName: f.aeTitleFromName,
        hosts: [f.host],
        port: f.port,
        tls: f.tls,
        tlsPort: f.tlsPort,
      });
    }
  }
  return [...items.values()];
}

/**
 * 検出した機器を、リモート AE の行にする。TLS を受ける相手は、TLS のポートで TLS ありとして足す
 * （平文より安全な側。使えなければ疎通確認で分かり、行で外せる）。
 */
export function toRow(item: DiscoveredItem, host: string): AeRow {
  const useTls = item.tls && item.tlsPort > 0;
  return { aeTitle: item.aeTitle, host, port: String(useTls ? item.tlsPort : item.port), tls: useTls };
}

/** 同じ AE タイトル（前後の空白は無視、大文字小文字は区別する）の行の位置。無ければ -1。 */
export function findSameAe(rows: AeRow[], aeTitle: string): number {
  const t = aeTitle.trim();
  return rows.findIndex((r) => r.aeTitle.trim() === t);
}

/**
 * 行を足す。同じ AE タイトルの行があれば、上書きするかを確認する（黙って上書きしない）。
 * 戻り値: 新しい行の配列と、実際に変えたか。
 */
export function addDiscovered(
  rows: AeRow[],
  item: DiscoveredItem,
  host: string,
  confirmOverwrite: (aeTitle: string) => boolean,
): { rows: AeRow[]; changed: boolean } {
  const row = toRow(item, host);
  const i = findSameAe(rows, row.aeTitle);
  if (i < 0) return { rows: [...rows, row], changed: true };
  if (!confirmOverwrite(row.aeTitle)) return { rows, changed: false };
  return { rows: rows.map((r, idx) => (idx === i ? row : r)), changed: true };
}

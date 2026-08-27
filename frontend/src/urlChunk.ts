/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 「多数の ID をクエリに並べる GET」を**安全な長さに分割する**ための純関数。
 *
 * <h3>なぜ要るか（実機で踏んだ・2026-08-27）</h3>
 * スタディ一覧の全 UID を 1 本の URL に詰めていたため、**スタディが 130 件を超えたところで
 * Tomcat の `maxHttpRequestHeaderSize`（既定 8KB）を超えて 400 になった**。
 *
 * <p>🚨 **症状が原因を指さない**。Tomcat は**リクエストラインのパース段階**で弾くので、
 * Spring の CORS フィルタまで到達せず `Access-Control-Allow-Origin` が付かない。
 * ブラウザには
 * <code>has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header</code>
 * としか見えず、**CORS の設定ミスを疑って何時間も溶かす**（プラグインの
 * `file://` CORS 事件と同じ見え方——`fw/security.md` §CORS）。backend 側のログに
 * `IllegalArgumentException: Request header is too large` が出ているかで見分ける。
 *
 * <p>🔴 **Tomcat の上限を上げる対処は採らない。** データが増えれば必ずまた超える。
 * 「URL に載せる件数を制御する」＝こちらが正しい直し方。
 */

/**
 * クエリ値に載せる ID 列を、URL エンコード後の長さで分割する。
 *
 * <p>件数ではなく**バイト長で切る**のが要点。UID の長さはデータ源で違う
 * （`1.2.826.0.1.3680043.10.1338.…` は 60 字超、`2.25.…` は 40 字前後）ので、
 * 固定件数だと「ある施設のデータでだけ落ちる」ことになる。
 *
 * @param values     並べたい ID
 * @param maxEncoded 1 リクエストあたりのクエリ**値**の上限（エンコード後の文字数）。
 *                   既定 3000 は、Tomcat の 8KB からパス・HTTP 版・ブラウザが付ける
 *                   ヘッダ（Host / User-Agent / Accept / sec-* …で 1〜2KB）を引いた
 *                   うえで十分な余裕を見た値。
 * @returns 分割後のかたまり。`values` が空なら空配列（＝リクエストを出さない）
 */
export function chunkForQuery(
  values: readonly string[],
  maxEncoded = 3000,
): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const v of values) {
    // 区切りのカンマはエンコードされて "%2C" の 3 文字になる。
    const cost = encodeURIComponent(v).length + (current.length ? 3 : 0);
    // **1 件だけは必ず入れる**。単体で上限を超える ID は分割しようがないので、
    // 空のかたまりを作って無限に進まなくなるのを防ぐ。
    if (current.length && length + cost > maxEncoded) {
      out.push(current);
      current = [];
      length = 0;
    }
    current.push(v);
    length += current.length === 1 ? encodeURIComponent(v).length : cost;
  }
  if (current.length) out.push(current);
  return out;
}

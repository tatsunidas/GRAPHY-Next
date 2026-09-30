// アダプタ共通の「設定で差を吸収する」部品。設計: fw/ai-routing-design.md §14
//
// 🔑 **ここに置く理由**: 認証ヘッダ名・追加ヘッダ・パスの上書きは**どのアダプタでも同じ規則**で
// 効くべきもの。アダプタごとに書くと、足すたびに片方だけ対応した状態が生まれる。
//
// 🔴 **検査はしない。** 形の検査は `aiProviders.validateProvider` が済ませている（正本は 1 か所）。
//    ここは「検査済みの設定を電文に反映する」だけ。
//
// 🔴 **`electron` を import しないこと**（CI の Desktop ジョブは npm install しない）。

/**
 * 認証ヘッダ。**提供元の設定が既定を上書きする。**
 *
 * @param provider 検査済みの提供元（`auth` は未指定・旧文字列・`{header,prefix}` のいずれか）
 * @param apiKey   キーチェーンから取り出した鍵
 * @param fallback アダプタの既定 `{header, prefix}`
 */
function authHeaders(provider, apiKey, fallback) {
  const auth = provider && typeof provider.auth === "object" && provider.auth !== null ? provider.auth : {};
  const header = auth.header || fallback.header;
  // 🔑 **空文字の接頭辞は「接頭辞なし」**（`x-api-key` 系）。`||` で既定へ落とすと
  //    `prefix: ""` を書いた人の意図を無視して `Bearer ` が付いてしまう。
  const prefix = auth.prefix != null ? auth.prefix : fallback.prefix || "";
  return { [header]: `${prefix}${apiKey}` };
}

/**
 * その用途のパス。**提供元の設定があればそれを使う。**
 *
 * <p>差し込みはしない（完全置換のみ）。`{model}` のような雛形を許すと、
 * 「電文を記述する小さな言語」が始まりエンコードの問題が戻ってくる。
 */
function pathFor(provider, capability, defaultPath) {
  const paths = provider && provider.paths;
  const override = paths && typeof paths[capability] === "string" ? paths[capability] : null;
  return override || defaultPath;
}

/**
 * ヘッダをまとめる。**アダプタのヘッダが常に勝つ。**
 *
 * <p>🔴 素の spread（`{...extra, ...own}`）では守れない——JS オブジェクトは
 * `Authorization` と `authorization` を**別のキー**として保持し、`http.request` は
 * 与えられた順に `setHeader` するので**後のキーが勝つ**。アダプタ側の名前は
 * `Authorization` / `Content-Type` / `x-goog-api-key` と大小が混在しているため、
 * 大小を無視して突き合わせないと**設定ヘッダが認証を上書きできる**。
 *
 * @param own   アダプタが組んだヘッダ（Content-Type と認証）
 * @param extra 提供元の設定にある追加ヘッダ（すべて小文字・検査済み）
 */
function mergeHeaders(own, extra) {
  if (!extra) return own;
  const ownLower = new Set(Object.keys(own).map((k) => k.toLowerCase()));
  const out = {};
  for (const [k, v] of Object.entries(extra)) {
    if (!ownLower.has(k.toLowerCase())) out[k] = v;
  }
  return { ...out, ...own };
}

module.exports = { authHeaders, pathFor, mergeHeaders };

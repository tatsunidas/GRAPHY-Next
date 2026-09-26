// 外部 AI への送出だけを持つ層。設計: fw/ai-routing-design.md §14
//
// 🔑 **ここを分けた理由は 2 つ。**
//   1. **テストで差し替えられるようにする**——組み立てた電文が意図どおりかは
//      ネットワークに出さずに確かめたい（`aiGateway` は `aiHttp.post` をモジュール越しに呼ぶ）。
//   2. 送出の作法（ポート・平文・上限・タイムアウト）を 1 か所に集める。
//
// 🔴 **リダイレクトを追わない。** 302 で鍵と患者画素が、利用者が同意していないホストへ行く。
//    200 以外は素直にエラーにする（`aiGateway` が分類する）。
// 🔴 **`rejectUnauthorized: false` を入れない。** 自院ホスト対応で必ず要望が来るが、
//    証明書を確かめずに患者画素を出す口は作らない。
// 🔴 **`electron` を import しないこと**（CI の Desktop ジョブは npm install しない）。

const https = require("node:https");
const http = require("node:http");

const TIMEOUT_MS = 120000;
/** 画像生成のレスポンスは base64 で数 MB になる。青天井にはしない。 */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

/**
 * POST する。**認証ヘッダと本文の形はアダプタが決める。**
 *
 * <p>🔑 提供元ごとに認証の載せ方が違う（`x-goog-api-key` / `Authorization: Bearer` /
 * Azure の `api-key`）。ここで 1 つに決め打ちにすると、提供元を足すたびにこの層を触ることになる。
 *
 * @param headers アダプタが組んだヘッダ（`Content-Type` と認証を含む）
 * @param body    送る本文（Buffer）。JSON でも multipart でもここでは区別しない
 */
function post(target, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    // 🔴 **`host` にポートを含めて渡してはいけない**（Node は解釈しない）。
    //    以前はそうしていたので、`https://ai.hosp.local:8443` が名前解決で落ちていた。
    const transport = target.plaintext ? http : https;
    const req = transport.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: pathname,
        method: "POST",
        headers: {
          // 🔴 **Content-Length は最後に置く。** アダプタや設定のヘッダで上書きされると
          //    本文の長さが食い違い、相手の解釈が壊れる（検査でも弾いているが二重に守る）。
          "User-Agent": "GRAPHY-Next",
          ...headers,
          "Content-Length": body.length,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy();
            reject(new Error(`レスポンスが上限(${MAX_RESPONSE_BYTES} バイト)を超えました`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 下で statusCode とともに扱う */
          }
          resolve({ statusCode: res.statusCode, json, text });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`タイムアウト(${TIMEOUT_MS} ms)`)));
    req.end(body);
  });
}
module.exports = { post, TIMEOUT_MS, MAX_RESPONSE_BYTES };

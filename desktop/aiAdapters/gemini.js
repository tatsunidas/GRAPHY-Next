// Gemini の電文アダプタ。設計: fw/ai-routing-design.md
//
// ここが持つのは 2 つだけ:
//   1. 用途（capability）→ Gemini の要求 body
//   2. Gemini の応答 → **提供元非依存の形**（image / text）
//
// 🔑 **応答の正規化を本体に置くのが、複数提供元を扱えるようにする要点。**
//    以前はプラグインが `candidates[].content.parts[]` を直接読んでいた。そのままでは
//    提供元が増えた瞬間に**プラグインごとに解釈が生える**——鍵の持ち方も同意の出し方も
//    ばらばらになり、外部送信の経路が把握できなくなる。
//
// 🔴 **`electron` を import しないこと。** desktop/ のテストは `node --test` で
//    **npm install 無し**に走る（CI の Desktop ジョブ）。electron に触ると
//    `Cannot find module 'electron'` でファイルごと落ちる（2026-09-24 に実際に CI を赤くした）。
//    ここは純粋な変換だけに保つ。HTTP も鍵も扱わない。

/** この提供元の種類。`ai-providers.json` の `kind` と対応する。 */
const KIND = "gemini";

/** 公開エンドポイント。企業向け（Vertex 等）は設定の `endpoint` で差し替える（段 3）。 */
const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com";

const DEFAULT_API_VERSION = "v1beta";

/**
 * 用途 → 要求する応答の種類。
 *
 * <p>⚠ `image-to-image` で TEXT も要求するのは意図的。画像モデルは説明を返さないことも
 * あるが、返るなら一緒に受け取れたほうがよい（往復が 1 回で済む）。
 */
const RESPONSE_MODALITIES = {
  "image-to-image": ["TEXT", "IMAGE"],
  "image-to-text": ["TEXT"],
};

/** この用途を扱えるか。扱えない用途は呼び出し元が手前で断る。 */
function supports(capability) {
  return Object.prototype.hasOwnProperty.call(RESPONSE_MODALITIES, capability);
}

/**
 * 要求を組む。
 *
 * @param {{capability?: string, model: string, apiVersion?: string, prompt: string,
 *          imageBase64: string, mimeType?: string, temperature?: number,
 *          responseModalities?: string[], providerOptions?: object}} req
 * @returns {{path: string, body: object}}
 */
function buildRequest(req) {
  const apiVersion = req.apiVersion || DEFAULT_API_VERSION;
  // 🔴 用途が来ていればそれを使う。来ていなければ**従来どおり** responseModalities を尊重する
  //    ——既存プラグイン（0.3.0 で配ったもの）を壊さないため。
  const modalities = req.capability && supports(req.capability)
    ? RESPONSE_MODALITIES[req.capability]
    : Array.isArray(req.responseModalities) && req.responseModalities.length > 0
      ? req.responseModalities
      : ["TEXT", "IMAGE"];

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: req.prompt },
          { inline_data: { mime_type: req.mimeType || "image/png", data: req.imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      responseModalities: modalities,
      ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
    },
  };

  // 提供元固有の追い込み。**無くても動くこと**が前提なので、上書きは generationConfig に限る。
  if (req.providerOptions && typeof req.providerOptions === "object") {
    Object.assign(body.generationConfig, req.providerOptions);
  }

  return { path: `/${apiVersion}/models/${req.model}:generateContent`, body };
}

function asRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

/** `inlineData` / `inline_data` のどちらでも拾う（Gemini はどちらも返す）。 */
function readInlineData(part) {
  const inline = asRecord(part.inlineData) || asRecord(part.inline_data);
  if (!inline) return null;
  if (typeof inline.data !== "string" || inline.data.length === 0) return null;
  const mime = inline.mimeType || inline.mime_type;
  return { base64: inline.data, mimeType: typeof mime === "string" ? mime : "image/png" };
}

/**
 * 応答を提供元非依存の形へ落とす。
 *
 * <p>🔴 **壊れた応答で例外を投げない。** 画像だけ返ってテキストが無いことも、その逆もある。
 * 「片方でも取れたなら成果はある」——呼び出し元が判断できるよう、取れたものだけ入れて返す。
 *
 * @returns {{image?: {base64: string, mimeType: string}, text?: string, blockReason?: string}}
 */
function normalize(json) {
  const root = asRecord(json);
  if (!root) return {};

  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const first = asRecord(candidates[0]);
  const content = asRecord(first && first.content);
  const parts = Array.isArray(content && content.parts) ? content.parts : [];

  const out = {};
  const texts = [];
  for (const p of parts) {
    const part = asRecord(p);
    if (!part) continue;
    if (typeof part.text === "string" && part.text.length > 0) texts.push(part.text);
    if (!out.image) {
      const inline = readInlineData(part);
      if (inline) out.image = inline;
    }
  }
  const text = texts.join("\n").trim();
  if (text) out.text = text;

  // 何も返らなかったときの理由。安全フィルタで止まった場合ここに入る。
  // 🔑 「返らなかった」と「拒否された」は利用者への案内が違うので区別して渡す。
  const reason =
    (first && typeof first.finishReason === "string" && first.finishReason !== "STOP"
      ? first.finishReason
      : null) ||
    (asRecord(root.promptFeedback) && typeof root.promptFeedback.blockReason === "string"
      ? root.promptFeedback.blockReason
      : null);
  if (!out.image && !out.text && reason) out.blockReason = reason;

  return out;
}

module.exports = { KIND, DEFAULT_ENDPOINT, DEFAULT_API_VERSION, supports, buildRequest, normalize };

// OpenAI 互換の電文アダプタ。設計: fw/ai-routing-design.md §4.2
//
// 1 つの実装で 2 つの `kind` を賄う:
//   - `openai`       … 公開 API（`/v1/...`・`Authorization: Bearer`）
//   - `azure-openai` … Azure OpenAI（`/openai/deployments/<model>/...`・`api-key` ヘッダ・
//                      `?api-version=` が必須）
// 🔑 **電文の中身（body と応答の形）は同じ**で、違うのはパスと認証だけ。
//    kind を 2 つに分けているのは「kind が電文の形を決める」という約束を守るため
//    （Azure はパスと認証が別なので、同じ kind に混ぜると分岐が body の中まで漏れる）。
//
// 🚨 **この電文の形は実機で確認していない。** 各社の API は版が変わるため、
//    **最初に使うときは 1 回だけ実際に送って確かめること**（fw/ai-routing-design.md §12）。
//    ここで固定しているのは「組み立てと解釈が自分の意図どおりか」だけで、
//    「相手がそれを受け付けるか」は別の話。出荷時の構成には入れていないので、
//    利用者が ai-providers.json に書くまで使われない。
//
// 🔴 **`electron` を import しないこと**（CI の Desktop ジョブは npm install しない）。

const KIND = "openai";
const KIND_AZURE = "azure-openai";

/** Azure は API バージョンの指定が必須。公開 API では使わない。 */
const DEFAULT_AZURE_API_VERSION = "2024-10-21";

/** 扱える用途。**画像生成は multipart なので経路が違う**（下記）。 */
const SUPPORTED = new Set(["image-to-image", "image-to-text"]);

function supports(capability) {
  return SUPPORTED.has(capability);
}

function isAzure(req) {
  return !!(req.provider && req.provider.kind === KIND_AZURE);
}

/** 認証ヘッダ。公開 API は Bearer、Azure は `api-key`。 */
function authHeaders(req) {
  return isAzure(req) ? { "api-key": req.apiKey } : { Authorization: `Bearer ${req.apiKey}` };
}

/** Azure は `?api-version=` が無いと 404 になる。公開 API では付けない。 */
function query(req) {
  if (!isAzure(req)) return "";
  const v = req.apiVersion || DEFAULT_AZURE_API_VERSION;
  return `?api-version=${encodeURIComponent(v)}`;
}

/**
 * 画像 ＋ 指示 → 文章（Chat Completions）。
 *
 * <p>画像は data URL として `image_url` に載せる（multipart は要らない）。
 */
function buildChat(req) {
  const dataUrl = `data:${req.mimeType || "image/png"};base64,${req.imageBase64}`;
  const body = {
    ...(isAzure(req) ? {} : { model: req.model }), // Azure はモデルをパスで指定する
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: req.prompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
  };
  if (req.providerOptions && typeof req.providerOptions === "object") {
    // 🔴 messages（＝送る画像と指示）は上書きさせない。
    for (const [k, v] of Object.entries(req.providerOptions)) {
      if (k !== "messages") body[k] = v;
    }
  }
  const path = isAzure(req)
    ? `/openai/deployments/${encodeURIComponent(req.model)}/chat/completions${query(req)}`
    : "/v1/chat/completions";
  return {
    path,
    headers: { "Content-Type": "application/json", ...authHeaders(req) },
    body: Buffer.from(JSON.stringify(body), "utf8"),
  };
}

/** multipart の 1 フィールド（テキスト）。 */
function textField(boundary, name, value) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    "utf8",
  );
}

/**
 * 画像 ＋ 指示 → 画像（Images Edits）。
 *
 * <p>⚠ **この経路だけ multipart/form-data。** 画像はファイルとして送る決まりなので、
 * JSON では送れない。境界文字列を作って手で組む（依存を増やさないため）。
 */
function buildImageEdit(req) {
  const boundary = `----GraphyNext${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const image = Buffer.from(req.imageBase64, "base64");
  const ext = (req.mimeType || "image/png").split("/")[1] || "png";

  const parts = [];
  if (!isAzure(req)) parts.push(textField(boundary, "model", req.model));
  parts.push(textField(boundary, "prompt", req.prompt));
  if (req.providerOptions && typeof req.providerOptions === "object") {
    for (const [k, v] of Object.entries(req.providerOptions)) {
      // 画像と指示は上書きさせない。
      if (k !== "image" && k !== "prompt") parts.push(textField(boundary, k, String(v)));
    }
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="source.${ext}"\r\n` +
        `Content-Type: ${req.mimeType || "image/png"}\r\n\r\n`,
      "utf8",
    ),
    image,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  );

  const path = isAzure(req)
    ? `/openai/deployments/${encodeURIComponent(req.model)}/images/edits${query(req)}`
    : "/v1/images/edits";
  return {
    path,
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, ...authHeaders(req) },
    body: Buffer.concat(parts),
  };
}

/**
 * 要求を組む。
 *
 * @returns {{path: string, headers: object, body: Buffer} | {error: string}}
 */
function buildRequest(req) {
  // 🔴 用途が無い呼び出し（0.3.0 のプラグイン）はここへ来ない想定だが、来たら断る。
  //    Gemini の語彙（responseModalities）をこちらで解釈すると、意味が合わない。
  if (!supports(req.capability)) return { error: "unsupported-capability" };
  return req.capability === "image-to-image" ? buildImageEdit(req) : buildChat(req);
}

function asRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

/**
 * 応答を提供元非依存の形へ落とす。
 *
 * <p>Chat Completions は `choices[].message.content`、Images は `data[].b64_json`。
 * **どちらも来うる**（用途で呼び分けているが、正規化は形で判断する）。
 *
 * <p>🔴 壊れた応答で例外を投げない。
 */
function normalize(json) {
  const root = asRecord(json);
  if (!root) return {};
  const out = {};

  // 画像（Images API）。
  const data = Array.isArray(root.data) ? root.data : [];
  for (const d of data) {
    const rec = asRecord(d);
    if (!rec) continue;
    if (typeof rec.b64_json === "string" && rec.b64_json.length > 0) {
      out.image = { base64: rec.b64_json, mimeType: "image/png" };
      break;
    }
  }

  // 文章（Chat Completions）。
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const texts = [];
  for (const c of choices) {
    const choice = asRecord(c);
    const message = asRecord(choice && choice.message);
    const content = message && message.content;
    if (typeof content === "string" && content.length > 0) {
      texts.push(content);
    } else if (Array.isArray(content)) {
      // 配列で返る形（部品ごと）にも対応する。
      for (const part of content) {
        const rec = asRecord(part);
        if (rec && typeof rec.text === "string" && rec.text.length > 0) texts.push(rec.text);
      }
    }
  }
  const text = texts.join("\n").trim();
  if (text) out.text = text;

  // 止められた理由。content_filter は「返らなかった」ではなく「拒否された」。
  if (!out.image && !out.text) {
    const first = asRecord(choices[0]);
    const reason = first && typeof first.finish_reason === "string" ? first.finish_reason : null;
    if (reason && reason !== "stop") out.blockReason = reason;
  }
  return out;
}

module.exports = {
  KIND,
  KIND_AZURE,
  DEFAULT_API_VERSION: undefined, // 公開 API は不要。Azure は DEFAULT_AZURE_API_VERSION
  DEFAULT_AZURE_API_VERSION,
  supports,
  buildRequest,
  normalize,
};

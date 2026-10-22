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
const wire = require("./wire");

const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com";

const DEFAULT_API_VERSION = "v1beta";

/** 既定の認証の載せ方。提供元の設定（`auth`）があればそちらが勝つ。 */
const DEFAULT_AUTH = { header: "x-goog-api-key", prefix: "" };

/**
 * モデル名が URL のパスに入るか。
 *
 * <p>🔴 Gemini は**常にパスに入る**（`/models/<model>:generateContent`）ので、
 * モデル名の検査は厳格側でなければならない（ゲートウェイが参照する）。
 */
function modelInPath() {
  return true;
}

/**
 * 用途 → 要求する応答の種類。
 *
 * <p>⚠ `image-to-image` で TEXT も要求するのは意図的。画像モデルは説明を返さないことも
 * あるが、返るなら一緒に受け取れたほうがよい（往復が 1 回で済む）。
 */
const RESPONSE_MODALITIES = {
  "image-to-image": ["TEXT", "IMAGE"],
  "image-to-text": ["TEXT"],
  "text-to-text": ["TEXT"],
  // 音声は buildTranscribeRequest が組む（画像の buildRequest は通らない）
  "speech-to-text": ["TEXT"],
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
 * @returns {{path: string, headers: object, body: Buffer}}
 */
function buildRequest(req) {
  // 会話の用途は画像を持たない 1 往復（接続テスト用）。本番の会話は buildChatRequest。
  if (req.capability === "text-to-text") {
    return buildChatRequest({ ...req, messages: [{ role: "user", text: req.prompt }] });
  }
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

  const provider = req.provider || {};
  const own = {
    "Content-Type": "application/json",
    ...wire.authHeaders(provider, req.apiKey, DEFAULT_AUTH),
  };
  return {
    path: wire.pathFor(provider, req.capability, `/${apiVersion}/models/${req.model}:generateContent`),
    // 認証の載せ方は提供元ごとに違う。既定はここが持ち、設定があればそれが勝つ。
    headers: wire.mergeHeaders(own, provider.headers),
    body: Buffer.from(JSON.stringify(body), "utf8"),
  };
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
/**
 * 音声 → 文字（generateContent に音声を載せる）。
 *
 * <p>🔑 専用の文字起こし API ではなく、音声を理解できる汎用モデルへ「そのまま書き起こす」と頼む形。
 * 要約や整形をさせない（患者の発話を勝手に言い換えない）ため、指示で縛り temperature 0 にする。
 *
 * @param {{model: string, apiVersion?: string, apiKey?: string, provider?: object,
 *          audio: {base64: string, mimeType: string}, language?: string}} req
 */
function buildTranscribeRequest(req) {
  const apiVersion = req.apiVersion || DEFAULT_API_VERSION;
  const provider = req.provider || {};
  const lang = req.language ? ` The speaker's language is ${req.language}.` : "";
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: `Transcribe this audio verbatim. Output only the transcript text, without summarizing, translating or adding comments.${lang}` },
          { inline_data: { mime_type: req.audio.mimeType, data: req.audio.base64 } },
        ],
      },
    ],
    generationConfig: { responseModalities: ["TEXT"], temperature: 0 },
  };
  const own = { "Content-Type": "application/json", ...wire.authHeaders(provider, req.apiKey, DEFAULT_AUTH) };
  return {
    path: wire.pathFor(provider, "speech-to-text", `/${apiVersion}/models/${req.model}:generateContent`),
    headers: wire.mergeHeaders(own, provider.headers),
    body: Buffer.from(JSON.stringify(body), "utf8"),
  };
}

/** 文字起こしの応答 → `{text}` / `{blockReason}`。読めなければ空。 */
function parseTranscript(json) {
  const n = normalize(json);
  return n.text ? { text: n.text } : n.blockReason ? { blockReason: n.blockReason } : {};
}

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


// ── 会話（text-to-text・ツール・ストリーミング） ───────────────────────────

/** Gemini の関数宣言が受ける Schema のキー。ここに無いものは落とす（`additionalProperties` など）。 */
const SCHEMA_KEYS = new Set([
  "type", "format", "description", "nullable", "enum", "properties", "required", "items",
  "minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength", "pattern", "anyOf",
]);

/**
 * JSON Schema → Gemini の Schema。**受けないキーを落とし、`type: [X,"null"]` を `nullable` に直す。**
 * 落とした制約は検査されなくなる——呼び出し側（アクション層）が引数を自分で検証する前提。
 */
function toGeminiSchema(schema) {
  const src = asRecord(schema);
  if (!src) return { type: "object", properties: {} };
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "oneOf" && Array.isArray(v)) { out.anyOf = v.map(toGeminiSchema); continue; }
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === "type" && Array.isArray(v)) {
      const types = v.filter((t) => t !== "null");
      out.type = types[0] || "string";
      if (v.includes("null")) out.nullable = true;
    } else if (k === "properties" && asRecord(v)) {
      out.properties = Object.fromEntries(Object.entries(v).map(([n, sub]) => [n, toGeminiSchema(sub)]));
    } else if (k === "items") {
      out.items = toGeminiSchema(v);
    } else if (k === "anyOf" && Array.isArray(v)) {
      out.anyOf = v.map(toGeminiSchema);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 会話 → `contents` と `systemInstruction`。連続する tool 結果は 1 つの user にまとめる。 */
function toContents(messages) {
  const system = [];
  const contents = [];
  for (const m of messages) {
    const text = wire.messageText(m);
    if (m.role === "system") { if (text) system.push(text); continue; }
    if (m.role === "tool") {
      const part = { functionResponse: { name: String(m.toolName || ""), response: { result: text } } };
      const last = contents[contents.length - 1];
      if (last && last.role === "user" && last.parts.every((p) => p.functionResponse)) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
      continue;
    }
    if (m.role === "assistant") {
      const parts = [];
      if (text) parts.push({ text });
      for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
        const sig = c.providerState && c.providerState.thoughtSignature;
        parts.push({
          functionCall: { name: String(c.name), args: c.args || {} },
          // 思考署名は不透明な値。**そのまま返さないと次のターンが 400 になる**ことがある。
          ...(typeof sig === "string" && sig ? { thoughtSignature: sig } : {}),
        });
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
      continue;
    }
    const parts = [];
    if (text) parts.push({ text });
    for (const im of Array.isArray(m.images) ? m.images : []) {
      parts.push({ inline_data: { mime_type: im.mimeType || "image/png", data: im.base64 } });
    }
    if (parts.length > 0) contents.push({ role: "user", parts });
  }
  return { system, contents };
}

/**
 * 会話の要求を組む。**1 呼び出し＝1 ターン**。
 *
 * <p>`paths` で上書きされたパスは `:streamGenerateContent` へ切り替えられないので、
 * その場合は非ストリーミングで送る（`streaming:false` を返す）。
 */
function buildChatRequest(req) {
  const apiVersion = req.apiVersion || DEFAULT_API_VERSION;
  const provider = req.provider || {};
  const { system, contents } = toContents(req.messages);
  const tools = provider.toolMode === "none" ? [] : req.tools || [];
  const body = {
    contents,
    ...(system.length > 0 ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] } } : {}),
    ...(tools.length > 0
      ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description || "", parameters: toGeminiSchema(t.parameters) })) }] }
      : {}),
    ...(typeof req.temperature === "number" ? { generationConfig: { temperature: req.temperature } } : {}),
  };
  if (req.providerOptions && typeof req.providerOptions === "object" && body.generationConfig) {
    Object.assign(body.generationConfig, req.providerOptions);
  } else if (req.providerOptions && typeof req.providerOptions === "object") {
    body.generationConfig = { ...req.providerOptions };
  }
  const own = { "Content-Type": "application/json", ...wire.authHeaders(provider, req.apiKey, DEFAULT_AUTH) };
  const overridden = !!(provider.paths && typeof provider.paths["text-to-text"] === "string");
  const streaming = !!req.stream && !overridden;
  const defaultPath = streaming
    ? `/${apiVersion}/models/${req.model}:streamGenerateContent?alt=sse`
    : `/${apiVersion}/models/${req.model}:generateContent`;
  return {
    path: wire.pathFor(provider, "text-to-text", defaultPath),
    headers: wire.mergeHeaders(own, provider.headers),
    body: Buffer.from(JSON.stringify(body), "utf8"),
    streaming,
  };
}

/** 1 つの応答（またはストリームの 1 チャンク）の `parts` を読む。ID はここで採番する。 */
function readChatParts(json, makeId) {
  const root = asRecord(json);
  const candidates = Array.isArray(root && root.candidates) ? root.candidates : [];
  const first = asRecord(candidates[0]);
  const content = asRecord(first && first.content);
  const parts = Array.isArray(content && content.parts) ? content.parts : [];
  const texts = [];
  const toolCalls = [];
  for (const p of parts) {
    const part = asRecord(p);
    if (!part) continue;
    if (part.thought === true) continue; // 思考の要約は会話に出さない
    if (typeof part.text === "string" && part.text.length > 0) texts.push(part.text);
    const fc = asRecord(part.functionCall);
    if (fc && typeof fc.name === "string" && fc.name) {
      const parsed = wire.parseToolArgs(fc.args);
      const sig = part.thoughtSignature || part.thought_signature;
      toolCalls.push({
        id: makeId(),
        name: fc.name,
        args: parsed.args,
        ...(parsed.argsError ? { argsError: parsed.argsError } : {}),
        ...(typeof sig === "string" && sig ? { providerState: { thoughtSignature: sig } } : {}),
      });
    }
  }
  const reason =
    (first && typeof first.finishReason === "string" ? first.finishReason : null);
  const blocked = asRecord(root && root.promptFeedback) && typeof root.promptFeedback.blockReason === "string"
    ? root.promptFeedback.blockReason
    : null;
  return { texts, toolCalls, reason, blocked };
}

let idCounter = 0;
function defaultMakeId() {
  idCounter += 1;
  return `call-${Date.now().toString(36)}-${idCounter}`;
}

/** 会話の応答（非ストリーミング）→ 提供元非依存の形。 */
function normalizeChat(json, opts) {
  const { texts, toolCalls, reason, blocked } = readChatParts(json, (opts && opts.makeId) || defaultMakeId);
  const out = {};
  const text = texts.join("").trim();
  if (text) out.text = text;
  if (toolCalls.length > 0) out.toolCalls = toolCalls;
  if (reason) out.finishReason = reason;
  if (!out.text && !out.toolCalls) {
    const why = blocked || (reason && reason !== "STOP" ? reason : null);
    if (why) out.blockReason = why;
  }
  return out;
}

/** ストリームは 1 チャンクごとに完全な応答の形。テキストは連結し、関数呼び出しは順に集める。 */
function createStreamParser(opts) {
  const makeId = (opts && opts.makeId) || defaultMakeId;
  let text = "";
  const toolCalls = [];
  let reason = null;
  let blocked = null;
  return {
    push(data) {
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return [];
      }
      const r = readChatParts(json, makeId);
      toolCalls.push(...r.toolCalls);
      if (r.reason) reason = r.reason;
      if (r.blocked) blocked = r.blocked;
      const chunk = r.texts.join("");
      if (!chunk) return [];
      text += chunk;
      return [{ type: "delta", text: chunk }];
    },
    result() {
      const out = {};
      const t = text.trim();
      if (t) out.text = t;
      if (toolCalls.length > 0) out.toolCalls = toolCalls;
      if (reason) out.finishReason = reason;
      if (!out.text && !out.toolCalls) {
        const why = blocked || (reason && reason !== "STOP" ? reason : null);
        if (why) out.blockReason = why;
      }
      return out;
    },
  };
}

/**
 * モデル一覧の要求（`GET /<版>/models`）。ページ送りは `pageToken`。
 *
 * <p>`pageSize` は上限に近い値を付ける（既定は 50 件で、モデルが増えると 1 ページで足りない）。
 */
function buildListRequest(req) {
  const apiVersion = req.apiVersion || DEFAULT_API_VERSION;
  const provider = req.provider || {};
  const q = `?pageSize=1000${req.pageToken ? `&pageToken=${encodeURIComponent(req.pageToken)}` : ""}`;
  return {
    path: `/${apiVersion}/models${q}`,
    headers: wire.mergeHeaders({ Accept: "application/json", ...wire.authHeaders(provider, req.apiKey, DEFAULT_AUTH) }, provider.headers),
  };
}

/**
 * `{models:[{name:"models/x", supportedGenerationMethods:[...]}], nextPageToken}` → 名前の配列。
 *
 * <p>🔑 Gemini の一覧は**能力の情報を持つ**ので、`generateContent` を扱えるものだけに絞る
 * （埋め込み専用のモデルなどを選ばせない）。名前の部分一致では絞らない。
 */
function parseModelList(json) {
  const models = asRecord(json) && Array.isArray(json.models) ? json.models : null;
  if (!models) return null;
  const ids = [];
  for (const m of models) {
    const r = asRecord(m);
    if (!r || typeof r.name !== "string") continue;
    const methods = Array.isArray(r.supportedGenerationMethods) ? r.supportedGenerationMethods : [];
    if (!methods.includes("generateContent")) continue;
    ids.push(r.name.replace(/^models\//, ""));
  }
  return { ids, next: typeof json.nextPageToken === "string" && json.nextPageToken ? json.nextPageToken : null };
}

module.exports = {
  KIND,
  DEFAULT_AUTH,
  modelInPath,
  DEFAULT_ENDPOINT,
  DEFAULT_API_VERSION,
  /**
   * 用途を指定しない呼び出し（0.3.0 のプラグイン）を受けられるか。
   *
   * <p>🔑 **Gemini だけ true。** あの形は `responseModalities` で応答の種類を言う
   * Gemini の語彙なので、他社の電文には対応する概念が無い。
   */
  acceptsLegacyRequest: true,
  supports,
  buildRequest,
  buildChatRequest,
  buildTranscribeRequest,
  parseTranscript,
  normalizeChat,
  createStreamParser,
  toGeminiSchema,
  buildListRequest,
  parseModelList,
  normalize,
};

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

const wire = require("./wire");

const KIND = "openai";
const KIND_AZURE = "azure-openai";

/** Azure は API バージョンの指定が必須。公開 API では使わない。 */
const DEFAULT_AZURE_API_VERSION = "2024-10-21";

/** 扱える用途。**画像生成は multipart なので経路が違う**（下記）。 */
const SUPPORTED = new Set(["image-to-image", "image-to-text", "text-to-text", "speech-to-text"]);

function supports(capability, provider) {
  // Azure の文字起こしはデプロイ単位のパスと api-version が絡む。実機で確かめられないので今回は扱わない。
  if (capability === "speech-to-text" && provider && effectiveStyle({ provider }) === "azure-deployment") return false;
  return SUPPORTED.has(capability);
}

/**
 * パスと認証の作法を決める。
 *
 * <p>🔑 **`kind: "azure-openai"` と `pathStyle: "azure-deployment"` のどちらでも同じ扱い。**
 * kind は「電文の系統」を表す既存の入口（互換のため残す）、`pathStyle` は
 * 「同じ系統の中でのパスの組み方」を設定で選ぶための後から足した口（§14）。
 * 畳まずに並べているので、既存の設定ファイルもテストもそのまま通る。
 */
function effectiveStyle(req) {
  const p = req.provider || {};
  if (p.pathStyle === "azure-deployment") return "azure-deployment";
  if (p.pathStyle === "openai") return "openai";
  return p.kind === KIND_AZURE ? "azure-deployment" : "openai";
}

function isAzure(req) {
  return effectiveStyle(req) === "azure-deployment";
}

/**
 * モデル名が URL のパスに入るか。
 *
 * <p>Azure はデプロイ名をパスに入れるので**厳格な検査が要る**。公開 API は body に入れるので、
 * `openai/gpt-4o` のような**スラッシュ入りのモデル名**（OpenRouter 形式）を許せる。
 */
function modelInPath(provider) {
  return effectiveStyle({ provider }) === "azure-deployment";
}

/**
 * 既定の認証。**公開 API は Bearer、Azure は `api-key`。** 提供元の設定があればそちらが勝つ。
 */
function defaultAuth(req) {
  return isAzure(req) ? { header: "api-key", prefix: "" } : { header: "Authorization", prefix: "Bearer " };
}

function authHeaders(req) {
  return wire.authHeaders(req.provider || {}, req.apiKey, defaultAuth(req));
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
  const fallbackPath = isAzure(req)
    ? `/openai/deployments/${encodeURIComponent(req.model)}/chat/completions${query(req)}`
    : "/v1/chat/completions";
  const own = { "Content-Type": "application/json", ...authHeaders(req) };
  return {
    path: wire.pathFor(req.provider, req.capability, fallbackPath),
    headers: wire.mergeHeaders(own, req.provider && req.provider.headers),
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

  const fallbackPath = isAzure(req)
    ? `/openai/deployments/${encodeURIComponent(req.model)}/images/edits${query(req)}`
    : "/v1/images/edits";
  const own = { "Content-Type": `multipart/form-data; boundary=${boundary}`, ...authHeaders(req) };
  return {
    path: wire.pathFor(req.provider, req.capability, fallbackPath),
    headers: wire.mergeHeaders(own, req.provider && req.provider.headers),
    body: Buffer.concat(parts),
  };
}

/** 音声ファイルの拡張子（multipart のファイル名用。内容の判別は相手が中身で行う）。 */
function audioExt(mimeType) {
  const sub = String(mimeType || "").split("/")[1] || "wav";
  const base = sub.split(";")[0].replace(/^x-/, "");
  return /^[a-z0-9]{1,5}$/.test(base) ? base : "wav";
}

/**
 * 音声 → 文字。
 *
 * <p>🔑 **経路は 2 通り。** 公開 API 互換は `/v1/audio/transcriptions`（multipart）。
 * ローカルの llama-server は音声を chat completions の `input_audio` で受けるので、
 * 提供元の `paths["speech-to-text"]` が `…/chat/completions` ならそちらの形で組む
 * （スキーマに項目を足さず、既存の「パスの上書き」に乗せた）。
 */
function buildTranscribeRequest(req) {
  const override = req.provider && req.provider.paths && req.provider.paths["speech-to-text"];
  const own = authHeaders(req);
  if (typeof override === "string" && /\/chat\/completions$/.test(override)) {
    const body = {
      model: req.model,
      messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: req.audio.base64, format: audioExt(req.audio.mimeType) } }] }],
      temperature: 0,
      max_tokens: 1024,
    };
    return {
      path: override,
      headers: wire.mergeHeaders({ "Content-Type": "application/json", ...own }, req.provider && req.provider.headers),
      body: Buffer.from(JSON.stringify(body), "utf8"),
    };
  }
  const boundary = `----GraphyNext${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const parts = [textField(boundary, "model", req.model), textField(boundary, "response_format", "json")];
  if (req.language) parts.push(textField(boundary, "language", req.language));
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${audioExt(req.audio.mimeType)}"\r\n` +
        `Content-Type: ${req.audio.mimeType}\r\n\r\n`,
      "utf8",
    ),
    Buffer.from(req.audio.base64, "base64"),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  );
  return {
    path: wire.pathFor(req.provider, "speech-to-text", "/v1/audio/transcriptions"),
    headers: wire.mergeHeaders({ "Content-Type": `multipart/form-data; boundary=${boundary}`, ...own }, req.provider && req.provider.headers),
    body: Buffer.concat(parts),
  };
}

/** Qwen3-ASR が先頭に付ける `language Japanese<asr_text>` を取り除く。 */
const ASR_PREFIX_RE = /^\s*language\s+[^<\n]{0,40}<asr_text>/i;

/** 文字起こしの応答 → `{text}`。transcriptions の `{text}` も chat の `choices[0].message.content` も読む。 */
function parseTranscript(json) {
  if (!json || typeof json !== "object") return {};
  let text = typeof json.text === "string" ? json.text : null;
  if (text == null) {
    const c = Array.isArray(json.choices) && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (typeof c === "string") text = c;
  }
  text = (text || "").replace(ASR_PREFIX_RE, "").trim();
  return text ? { text } : {};
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
  // 会話の用途は画像を持たない 1 往復（接続テスト用）。本番の会話は buildChatRequest。
  if (req.capability === "text-to-text") {
    return buildChatRequest({ ...req, messages: [{ role: "user", text: req.prompt }] });
  }
  return req.capability === "image-to-image" ? buildImageEdit(req) : buildChat(req);
}

// ── 会話（text-to-text・ツール・ストリーミング） ───────────────────────────

/** 会話 1 件 → Chat Completions の message。 */
function toChatMessage(m) {
  const text = wire.messageText(m);
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: String(m.toolCallId || ""), content: text };
  }
  if (m.role === "assistant") {
    const out = { role: "assistant", content: text || null };
    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((c) => ({
        id: String(c.id),
        type: "function",
        function: { name: String(c.name), arguments: JSON.stringify(c.args || {}) },
      }));
    }
    return out;
  }
  const images = Array.isArray(m.images) ? m.images : [];
  if (m.role === "user" && images.length > 0) {
    return {
      role: "user",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...images.map((im) => ({
          type: "image_url",
          image_url: { url: `data:${im.mimeType || "image/png"};base64,${im.base64}` },
        })),
      ],
    };
  }
  return { role: m.role === "system" ? "system" : "user", content: text };
}

/**
 * 会話の要求を組む。**1 呼び出し＝1 ターン**（ツール結果を受けて次を呼ぶループは呼び出し側）。
 *
 * @param {{model: string, messages: object[], tools?: object[], stream?: boolean,
 *          temperature?: number, providerOptions?: object, provider: object, apiKey?: string}} req
 * @returns {{path: string, headers: object, body: Buffer, streaming: boolean}}
 */
function buildChatRequest(req) {
  const tools = req.provider && req.provider.toolMode === "none" ? [] : req.tools || [];
  const body = {
    ...(isAzure(req) ? {} : { model: req.model }),
    messages: req.messages.map(toChatMessage),
    ...(tools.length > 0
      ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.parameters || { type: "object", properties: {} } } })) }
      : {}),
    ...(req.stream ? { stream: true } : {}),
    ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
  };
  if (req.providerOptions && typeof req.providerOptions === "object") {
    // 🔴 送る内容（messages・tools・model・stream）は上書きさせない。
    for (const [k, v] of Object.entries(req.providerOptions)) {
      if (!["messages", "tools", "tool_choice", "model", "stream"].includes(k)) body[k] = v;
    }
  }
  const fallbackPath = isAzure(req)
    ? `/openai/deployments/${encodeURIComponent(req.model)}/chat/completions${query(req)}`
    : "/v1/chat/completions";
  const own = {
    "Content-Type": "application/json",
    ...(req.stream ? { Accept: "text/event-stream" } : {}),
    ...authHeaders(req),
  };
  return {
    path: wire.pathFor(req.provider, "text-to-text", fallbackPath),
    headers: wire.mergeHeaders(own, req.provider && req.provider.headers),
    body: Buffer.from(JSON.stringify(body), "utf8"),
    streaming: !!req.stream,
  };
}

/** `tool_calls[]` → 提供元非依存の形。引数が壊れていれば `argsError` を付ける。 */
function readToolCalls(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    const rec = asRecord(c);
    const fn = asRecord(rec && rec.function);
    if (!fn || typeof fn.name !== "string" || !fn.name) continue;
    const parsed = wire.parseToolArgs(fn.arguments);
    out.push({
      id: typeof rec.id === "string" && rec.id ? rec.id : `call-${out.length}`,
      name: fn.name,
      args: parsed.args,
      ...(parsed.argsError ? { argsError: parsed.argsError } : {}),
    });
  }
  return out;
}

/**
 * 会話の応答（非ストリーミング）→ 提供元非依存の形。壊れた応答で例外を投げない。
 *
 * @returns {{text?: string, toolCalls?: object[], finishReason?: string, blockReason?: string}}
 */
function normalizeChat(json) {
  const root = asRecord(json);
  const choice = asRecord(root && Array.isArray(root.choices) ? root.choices[0] : null);
  if (!choice) return {};
  const message = asRecord(choice.message) || {};
  const out = {};
  const base = normalize({ choices: [{ message, finish_reason: choice.finish_reason }] });
  if (base.text) out.text = base.text;
  const toolCalls = readToolCalls(message.tool_calls);
  if (toolCalls.length > 0) out.toolCalls = toolCalls;
  const reason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
  if (reason) out.finishReason = reason;
  if (!out.text && !out.toolCalls && reason && reason !== "stop") out.blockReason = reason;
  return out;
}

/**
 * ストリーミング（SSE）の差分を溜める。`push(data)` は 1 イベントの `data:` 本文を受け、
 * 画面へ流す差分（`{type:"delta", text}`）を返す。`result()` は非ストリーミングと**同じ形**。
 *
 * <p>ツール呼び出しは `index` ごとに `arguments` の断片が分かれて届く。全部届いてから 1 件に組む。
 */
function createStreamParser() {
  let text = "";
  let finishReason = null;
  const calls = new Map();
  return {
    push(data) {
      if (data === "[DONE]") return [];
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        return [];
      }
      const choice = asRecord(Array.isArray(json && json.choices) ? json.choices[0] : null);
      if (!choice) return [];
      const events = [];
      const delta = asRecord(choice.delta) || {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        events.push({ type: "delta", text: delta.content });
      }
      for (const t of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const rec = asRecord(t);
        if (!rec) continue;
        const idx = Number.isInteger(rec.index) ? rec.index : 0;
        const cur = calls.get(idx) || { id: "", name: "", arguments: "" };
        if (typeof rec.id === "string" && rec.id) cur.id = rec.id;
        const fn = asRecord(rec.function);
        if (fn && typeof fn.name === "string") cur.name += fn.name;
        if (fn && typeof fn.arguments === "string") cur.arguments += fn.arguments;
        calls.set(idx, cur);
      }
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      return events;
    },
    result() {
      const tool_calls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => ({ id: c.id, function: { name: c.name, arguments: c.arguments } }));
      return normalizeChat({
        choices: [{ message: { content: text, tool_calls }, finish_reason: finishReason }],
      });
    },
  };
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

/**
 * モデル一覧の要求（`GET /v1/models`）。
 *
 * <p>🔑 Azure は**データ面にデプロイ名の一覧が無い**（管理面の別 API）ので出さない＝手入力にする。
 * 公開 API の一覧は能力の情報を持たない（名前だけ）ので、用途では絞らない。
 */
function buildListRequest(req) {
  if (isAzure(req)) return { error: "list-unsupported" };
  return {
    path: "/v1/models",
    headers: wire.mergeHeaders({ Accept: "application/json", ...authHeaders(req) }, req.provider && req.provider.headers),
  };
}

/** `{data:[{id}]}` → 名前の配列。形が違えば空（呼び出し側が「読めない」と言う）。 */
function parseModelList(json) {
  const data = asRecord(json) && Array.isArray(json.data) ? json.data : null;
  if (!data) return null;
  return { ids: data.map((m) => (asRecord(m) && typeof m.id === "string" ? m.id : null)).filter(Boolean), next: null };
}

module.exports = {
  KIND,
  KIND_AZURE,
  effectiveStyle,
  modelInPath,
  DEFAULT_API_VERSION: undefined, // 公開 API は不要。Azure は DEFAULT_AZURE_API_VERSION
  DEFAULT_AZURE_API_VERSION,
  supports,
  buildRequest,
  buildChatRequest,
  buildTranscribeRequest,
  parseTranscript,
  normalizeChat,
  createStreamParser,
  buildListRequest,
  parseModelList,
  normalize,
};

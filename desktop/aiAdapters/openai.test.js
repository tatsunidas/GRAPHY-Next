// `node --test`。設計: fw/ai-routing-design.md §4.2
//
// 🚨 **ここで確かめられるのは「組み立てと解釈が意図どおりか」だけ。**
// 「相手の API がそれを受け付けるか」は別問題で、実機で 1 回送って確かめる必要がある
// （§12）。それでもここを固定する価値は 2 つ:
//   1. 認証の載せ方・パスの形が Azure と公開 API で取り違えられていないこと
//   2. 画像と指示が providerOptions で**上書きされない**こと（送るものが変わらない）
//
// 🔴 electron を import しない（CI の Desktop ジョブは npm install しない）。

const test = require("node:test");
const assert = require("node:assert");
const openai = require("./openai");

const IMG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");

const PUBLIC = { kind: "openai", endpoint: "https://api.openai.test" };
const AZURE = { kind: "azure-openai", endpoint: "https://hosp.openai.azure.test" };

function req(over) {
  return { model: "m", prompt: "指示", imageBase64: IMG, mimeType: "image/png", apiKey: "KEY", ...over };
}
const json = (built) => JSON.parse(built.body.toString("utf8"));
/**
 * multipart のテキスト欄を見るための復号。
 *
 * ⚠ **latin1 で読まないこと。** 生バイトは保てるが UTF-8 の日本語が化けて、
 * 「指示が入っている」という検査が**間違って落ちる**（最初にこれで 2 件落とした）。
 * 画像の生バイトは `built.body.includes(Buffer)` で別に見る。
 */
const raw = (built) => built.body.toString("utf8");

// ── 扱える用途 ────────────────────────────────────────────────────────────

test("扱える用途を答える", () => {
  assert.equal(openai.supports("image-to-image"), true);
  assert.equal(openai.supports("image-to-text"), true);
  assert.equal(openai.supports("chat"), false);
});

test("🔴 用途が無い呼び出しは断る（Gemini の語彙をここで解釈しない）", () => {
  const r = openai.buildRequest(req({ provider: PUBLIC, responseModalities: ["TEXT"] }));
  assert.equal(r.error, "unsupported-capability");
});

// ── 画像 → 文章（Chat Completions・JSON） ─────────────────────────────────

test("公開 API: パスと Bearer 認証", () => {
  const r = openai.buildRequest(req({ provider: PUBLIC, capability: "image-to-text" }));
  assert.equal(r.path, "/v1/chat/completions");
  assert.equal(r.headers.Authorization, "Bearer KEY");
  assert.equal(r.headers["Content-Type"], "application/json");
  assert.equal(json(r).model, "m", "公開 API はモデルを body で指定する");
});

test("🔴 Azure: パスにモデル（デプロイ名）が入り、api-version が付き、認証ヘッダが違う", () => {
  const r = openai.buildRequest(req({ provider: AZURE, capability: "image-to-text" }));
  assert.match(r.path, /^\/openai\/deployments\/m\/chat\/completions\?api-version=/);
  assert.equal(r.headers["api-key"], "KEY");
  assert.equal(r.headers.Authorization, undefined, "Azure に Bearer を送らない");
  assert.equal(json(r).model, undefined, "Azure はモデルをパスで指定するので body に入れない");
});

test("Azure の api-version は設定で差し替えられる", () => {
  const r = openai.buildRequest(req({ provider: AZURE, capability: "image-to-text", apiVersion: "2025-01-01" }));
  assert.match(r.path, /api-version=2025-01-01$/);
});

test("画像は data URL として 1 枚だけ載る", () => {
  const r = openai.buildRequest(req({ provider: PUBLIC, capability: "image-to-text" }));
  const content = json(r).messages[0].content;
  assert.equal(content[0].text, "指示");
  assert.equal(content[1].image_url.url, `data:image/png;base64,${IMG}`);
  assert.equal(content.length, 2);
});

test("🔴 providerOptions で messages を上書きできない（送るものが変わらない）", () => {
  const r = openai.buildRequest(
    req({ provider: PUBLIC, capability: "image-to-text", providerOptions: { messages: [], top_p: 0.5 } }),
  );
  const body = json(r);
  assert.equal(body.top_p, 0.5, "他の指定は通る");
  assert.equal(body.messages[0].content[1].image_url.url.endsWith(IMG), true, "画像は残る");
});

// ── 画像 → 画像（Images Edits・multipart） ────────────────────────────────

test("multipart で組み、画像をファイルとして載せる", () => {
  const r = openai.buildRequest(req({ provider: PUBLIC, capability: "image-to-image" }));
  assert.equal(r.path, "/v1/images/edits");
  assert.match(r.headers["Content-Type"], /^multipart\/form-data; boundary=----GraphyNext/);

  const body = raw(r);
  const boundary = r.headers["Content-Type"].split("boundary=")[1];
  assert.ok(body.startsWith(`--${boundary}\r\n`), "境界で始まる");
  assert.ok(body.endsWith(`--${boundary}--\r\n`), "終端の境界で終わる");
  assert.match(body, /name="prompt"[\s\S]*指示/);
  assert.match(body, /name="image"; filename="source\.png"/);
  assert.match(body, /Content-Type: image\/png/);
  // 画像は base64 ではなく**生バイト**で載る。
  assert.ok(r.body.includes(Buffer.from(IMG, "base64")), "画像の生バイトが含まれる");
});

test("Azure の画像編集もパスと認証が変わる", () => {
  const r = openai.buildRequest(req({ provider: AZURE, capability: "image-to-image" }));
  assert.match(r.path, /^\/openai\/deployments\/m\/images\/edits\?api-version=/);
  assert.equal(r.headers["api-key"], "KEY");
  assert.equal(raw(r).includes('name="model"'), false, "Azure はモデルをパスで指定する");
});

test("🔴 providerOptions で画像と指示を差し替えられない", () => {
  const r = openai.buildRequest(
    req({ provider: PUBLIC, capability: "image-to-image", providerOptions: { image: "他の画像", prompt: "他の指示", size: "1024x1024" } }),
  );
  const body = raw(r);
  assert.equal(body.includes("他の画像"), false);
  assert.equal(body.includes("他の指示"), false);
  assert.match(body, /name="size"[\s\S]*1024x1024/);
  assert.match(body, /name="prompt"[\s\S]*指示/);
});

// ── 正規化 ────────────────────────────────────────────────────────────────

test("Chat Completions の文章を取り出す", () => {
  const out = openai.normalize({ choices: [{ message: { content: "説明文" }, finish_reason: "stop" }] });
  assert.equal(out.text, "説明文");
  assert.equal(out.image, undefined);
});

test("content が配列で返る形にも対応する", () => {
  const out = openai.normalize({
    choices: [{ message: { content: [{ type: "text", text: "行 1" }, { type: "text", text: "行 2" }] } }],
  });
  assert.equal(out.text, "行 1\n行 2");
});

test("Images API の画像を取り出す", () => {
  const out = openai.normalize({ data: [{ b64_json: IMG }] });
  assert.equal(out.image.base64, IMG);
  assert.equal(out.image.mimeType, "image/png");
});

test("🔴 壊れた応答で例外を投げない", () => {
  for (const bad of [null, undefined, {}, [], "文字列", { choices: null }, { choices: [{}] },
                     { data: [{}] }, { data: [{ b64_json: "" }] }, { choices: [{ message: null }] }]) {
    const out = openai.normalize(bad);
    assert.equal(typeof out, "object");
    assert.equal(out.image, undefined);
  }
});

test("🔴 拒否された理由を渡す（content_filter は「返らなかった」ではない）", () => {
  const out = openai.normalize({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] });
  assert.equal(out.blockReason, "content_filter");

  // 中身が取れているなら理由は付けない。
  const ok = openai.normalize({ choices: [{ message: { content: "出た" }, finish_reason: "length" }] });
  assert.equal(ok.blockReason, undefined);
  assert.equal(ok.text, "出た");
});

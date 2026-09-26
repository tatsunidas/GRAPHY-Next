// `node --test`（desktop/ で `npm test`）。設計: fw/ai-routing-design.md
//
// ここで守りたいのは 1 つ: **提供元の応答の形を、提供元非依存の形へ正しく落とすこと。**
// ここが狂うと「生成できたのに画像が出ない」「説明だけ消える」という形で壊れ、
// **例外は出ない**ので気付きにくい。応答の固定データで縛る。
//
// 🔴 このファイルは electron を import しない（CI の Desktop ジョブは npm install しない）。

const test = require("node:test");
const assert = require("node:assert");
const gemini = require("./gemini");

const IMG = "aGVsbG8="; // "hello" の base64。中身は問わない

/** buildRequest は送出可能な Buffer を返すので、検査のために JSON へ戻す。 */
function bodyOf(built) {
  return JSON.parse(built.body.toString("utf8"));
}

/** Gemini の応答の形（画像とテキストの両方が返った場合）。 */
function response(parts, extra) {
  return { candidates: [{ content: { parts }, ...(extra || {}) }] };
}

test("扱える用途を答える", () => {
  assert.equal(gemini.supports("image-to-image"), true);
  assert.equal(gemini.supports("image-to-text"), true);
  assert.equal(gemini.supports("chat"), false);
  assert.equal(gemini.supports(undefined), false);
});

test("用途から応答の種類が決まる", () => {
  const i2i = gemini.buildRequest({ capability: "image-to-image", model: "m", prompt: "p", imageBase64: IMG });
  assert.deepEqual(bodyOf(i2i).generationConfig.responseModalities, ["TEXT", "IMAGE"]);

  const i2t = gemini.buildRequest({ capability: "image-to-text", model: "m", prompt: "p", imageBase64: IMG });
  assert.deepEqual(bodyOf(i2t).generationConfig.responseModalities, ["TEXT"]);
});

test("🔴 用途が無ければ従来の responseModalities を尊重する（既存プラグインを壊さない）", () => {
  // 0.3.0 で配ったプラグインは capability を知らない。TEXT だけを要求してくる経路がある。
  const r = gemini.buildRequest({ model: "m", prompt: "p", imageBase64: IMG, responseModalities: ["TEXT"] });
  assert.deepEqual(bodyOf(r).generationConfig.responseModalities, ["TEXT"]);
});

test("パスにモデルと API バージョンが入る", () => {
  const r = gemini.buildRequest({ capability: "image-to-text", model: "gemini-2.5-flash", prompt: "p", imageBase64: IMG });
  assert.equal(r.path, "/v1beta/models/gemini-2.5-flash:generateContent");

  const v1 = gemini.buildRequest({ capability: "image-to-text", model: "m", apiVersion: "v1", prompt: "p", imageBase64: IMG });
  assert.equal(v1.path, "/v1/models/m:generateContent");
});

test("画像は inline_data として 1 つだけ載る", () => {
  const r = gemini.buildRequest({ capability: "image-to-image", model: "m", prompt: "描いて", imageBase64: IMG, mimeType: "image/png" });
  const parts = bodyOf(r).contents[0].parts;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].text, "描いて");
  assert.equal(parts[1].inline_data.data, IMG);
  assert.equal(parts[1].inline_data.mime_type, "image/png");
});

test("providerOptions は generationConfig にだけ効く", () => {
  const r = gemini.buildRequest({
    capability: "image-to-text", model: "m", prompt: "p", imageBase64: IMG,
    providerOptions: { topK: 3 },
  });
  assert.equal(bodyOf(r).generationConfig.topK, 3);
  // 🔴 contents（＝送る画像と指示）は提供元固有の指定で書き換えられない。
  assert.equal(bodyOf(r).contents[0].parts[1].inline_data.data, IMG);
});

// ── 正規化 ────────────────────────────────────────────────────────────────

test("画像とテキストの両方を取り出す", () => {
  const out = gemini.normalize(response([
    { text: "解説です" },
    { inlineData: { mimeType: "image/png", data: IMG } },
  ]));
  assert.equal(out.image.base64, IMG);
  assert.equal(out.image.mimeType, "image/png");
  assert.equal(out.text, "解説です");
});

test("inline_data（スネークケース）でも拾う", () => {
  const out = gemini.normalize(response([{ inline_data: { mime_type: "image/jpeg", data: IMG } }]));
  assert.equal(out.image.base64, IMG);
  assert.equal(out.image.mimeType, "image/jpeg");
});

test("テキストだけの応答（画像モデルでない提供元）", () => {
  const out = gemini.normalize(response([{ text: "行 1" }, { text: "行 2" }]));
  assert.equal(out.image, undefined);
  assert.equal(out.text, "行 1\n行 2");
});

test("🔴 壊れた応答で例外を投げない", () => {
  for (const bad of [null, undefined, {}, [], "文字列", { candidates: null }, { candidates: [{}] },
                     response([{ inlineData: { data: "" } }]), response([{ inlineData: null }])]) {
    const out = gemini.normalize(bad);
    assert.equal(typeof out, "object");
    assert.equal(out.image, undefined);
  }
});

test("🔴 止められたときは理由を渡す（「返らなかった」と「拒否された」は案内が違う）", () => {
  const safety = gemini.normalize({ candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] });
  assert.equal(safety.blockReason, "SAFETY");

  const prompt = gemini.normalize({ promptFeedback: { blockReason: "OTHER" } });
  assert.equal(prompt.blockReason, "OTHER");

  // 中身が取れているなら理由は付けない（成功として扱う）。
  const ok = gemini.normalize(response([{ text: "出た" }], { finishReason: "MAX_TOKENS" }));
  assert.equal(ok.blockReason, undefined);
  assert.equal(ok.text, "出た");
});

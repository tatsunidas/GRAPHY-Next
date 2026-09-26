// `node --test`。設計: fw/ai-routing-design.md §4
//
// ここで守りたいのは 3 つ。いずれも破れると**患者画素の送り先が変わる**:
//   1. 提供元 id の形（秘密情報のキー名に入る）
//   2. https 以外のエンドポイントを受け付けない
//   3. 「その用途を扱えない提供元」を既定にしない
//
// 🔴 electron を import しない（CI の Desktop ジョブは npm install しない）。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const providers = require("./aiProviders");

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "graphy-ai-providers-"));
}

/** 毎回まっさらに読み直す（＝アプリ再起動の代用）。 */
function freshStore(dir) {
  delete require.cache[require.resolve("./aiProviders")];
  const p = require("./aiProviders");
  p.init(dir);
  return p;
}

const GEMINI = {
  id: "g", kind: "gemini", endpoint: "https://example.test",
  models: { "image-to-image": "img", "image-to-text": "txt" },
};

// ── 検査 ──────────────────────────────────────────────────────────────────

test("🔴 提供元 id の形を強制する（秘密情報のキー名に入る）", () => {
  for (const bad of ["../etc", "A", "a".repeat(33), "a b", "", "a_b", "a.b"]) {
    const r = providers.normalize({ providers: [{ ...GEMINI, id: bad }] });
    assert.equal(r.providers.length, 0, `通ってはいけない id: ${JSON.stringify(bad)}`);
  }
  for (const good of ["g", "gemini-public", "azure-hosp-1", "a".repeat(32)]) {
    const r = providers.normalize({ providers: [{ ...GEMINI, id: good }] });
    assert.equal(r.providers.length, 1, `通るべき id: ${good}`);
  }
});

test("🔴 https 以外のエンドポイントを受け付けない（平文で患者画素を出さない）", () => {
  for (const bad of ["http://example.test", "ftp://x", "example.test", "", "https://"]) {
    const r = providers.normalize({ providers: [{ ...GEMINI, endpoint: bad }] });
    assert.equal(r.providers.length, 0, `通ってはいけない endpoint: ${JSON.stringify(bad)}`);
  }
});

test("末尾のスラッシュは落とす（パスを組むときに // にならないように）", () => {
  const r = providers.normalize({ providers: [{ ...GEMINI, endpoint: "https://example.test///" }] });
  assert.equal(r.providers[0].endpoint, "https://example.test");
});

test("未知の kind は捨てる（対応するアダプタが無い）", () => {
  for (const bad of ["anthropic", "deepseek", "grok", ""]) {
    const r = providers.normalize({ providers: [{ ...GEMINI, kind: bad }] });
    assert.equal(r.providers.length, 0, `アダプタが無い kind: ${bad}`);
    assert.ok(r.problems.some((p) => p.includes("unknown-kind")));
  }
});

test("OpenAI 互換の kind を受け付ける（Azure も同じ実装で扱う）", () => {
  for (const kind of ["openai", "azure-openai"]) {
    const r = providers.normalize({
      providers: [{ id: "p", kind, endpoint: "https://x.test", models: { "image-to-text": "m" } }],
    });
    assert.equal(r.providers.length, 1, kind);
    assert.equal(r.providers[0].kind, kind);
  }
});

test("🔑 扱えない用途は models に入れない（空文字は「使えない」と同じ）", () => {
  const r = providers.normalize({
    providers: [{ ...GEMINI, models: { "image-to-image": "  ", "image-to-text": "txt" } }],
  });
  assert.equal(r.providers[0].models["image-to-image"], undefined);
  assert.equal(r.providers[0].models["image-to-text"], "txt");
});

test("用途を 1 つも扱えない提供元は捨てる", () => {
  const r = providers.normalize({ providers: [{ ...GEMINI, models: {} }] });
  assert.equal(r.providers.length, 0);
});

test("壊れた 1 件で全体を捨てない（他の提供元は使えるべき）", () => {
  const r = providers.normalize({
    providers: [{ ...GEMINI, id: "BAD" }, { ...GEMINI, id: "ok" }],
  });
  assert.equal(r.providers.length, 1);
  assert.equal(r.providers[0].id, "ok");
  assert.equal(r.problems.length, 1);
});

test("id の重複は後ろを捨てる", () => {
  const r = providers.normalize({ providers: [GEMINI, { ...GEMINI, endpoint: "https://other.test" }] });
  assert.equal(r.providers.length, 1);
  assert.equal(r.providers[0].endpoint, "https://example.test");
});

// ── 既定の決め方 ──────────────────────────────────────────────────────────

test("🔴 その用途を扱えない提供元は既定にしない", () => {
  const textOnly = { id: "t", kind: "gemini", endpoint: "https://t.test", models: { "image-to-text": "txt" } };
  const r = providers.normalize({
    providers: [textOnly, GEMINI],
    defaults: { "image-to-image": "t" }, // t は画像生成を扱えない
  });
  // 扱える提供元へ落ちる。**「既定が壊れていたので送れない」にはしない。**
  assert.equal(r.defaults["image-to-image"], "g");
  assert.ok(r.problems.some((p) => p.includes("この用途を扱えません")));
});

test("既定が無ければ、その用途を扱える最初の提供元を使う", () => {
  const r = providers.normalize({ providers: [GEMINI] });
  assert.equal(r.defaults["image-to-image"], "g");
  assert.equal(r.defaults["image-to-text"], "g");
});

test("誰も扱えない用途には既定を作らない（存在しない宛先を作らない）", () => {
  const textOnly = { id: "t", kind: "gemini", endpoint: "https://t.test", models: { "image-to-text": "txt" } };
  const r = providers.normalize({ providers: [textOnly] });
  assert.equal(r.defaults["image-to-image"], undefined);
  assert.equal(r.defaults["image-to-text"], "t");
});

// ── 解決 ──────────────────────────────────────────────────────────────────

test("用途から提供元とモデルが引ける", () => {
  const p = freshStore(freshDir());
  const r = p.resolve("image-to-text");
  assert.equal(r.ok, true);
  assert.equal(r.provider.id, "gemini-public");
  assert.equal(r.model, "gemini-2.5-flash");
});

test("🔴 知らない用途と「扱える提供元が無い」を区別する（案内が違う）", () => {
  const p = freshStore(freshDir());
  assert.equal(p.resolve("chat").error, "unsupported-capability");

  const dir = freshDir();
  fs.writeFileSync(
    path.join(dir, p.FILE_NAME),
    JSON.stringify({ providers: [{ id: "t", kind: "gemini", endpoint: "https://t.test", models: { "image-to-text": "txt" } }] }),
  );
  const p2 = freshStore(dir);
  assert.equal(p2.resolve("image-to-image").error, "no-provider-for-capability");
  assert.equal(p2.resolve("image-to-text").ok, true);
});

// ── 保存と読み込み ────────────────────────────────────────────────────────

test("保存したものが読み直せる（アプリ再起動の代用）", () => {
  const dir = freshDir();
  const p = freshStore(dir);
  const r = p.save({ providers: [GEMINI, { ...GEMINI, id: "g2", models: { "image-to-text": "t2" } }],
                     defaults: { "image-to-text": "g2" } });
  assert.equal(r.ok, true);

  const p2 = freshStore(dir);
  assert.equal(p2.get().providers.length, 2);
  assert.equal(p2.resolve("image-to-text").provider.id, "g2");
  assert.equal(p2.resolve("image-to-image").provider.id, "g");
});

test("🔴 検査を通らない構成は保存しない（送り先を壊さない）", () => {
  const dir = freshDir();
  const p = freshStore(dir);
  const r = p.save({ providers: [{ ...GEMINI, endpoint: "http://plain.test" }] });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(path.join(dir, p.FILE_NAME)), false, "書き込んでいないこと");
});

test("ファイルが壊れていても出荷時の構成で動く（沈黙しない）", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, providers.FILE_NAME), "{ これは JSON ではない");
  const p = freshStore(dir);
  assert.equal(p.resolve("image-to-image").ok, true);
});

test("保存したファイルは 0600（他ユーザーから読めない）", () => {
  if (process.platform === "win32") return; // Windows の ACL は別物
  const dir = freshDir();
  const p = freshStore(dir);
  p.save({ providers: [GEMINI] });
  const mode = fs.statSync(path.join(dir, p.FILE_NAME)).mode & 0o777;
  assert.equal(mode, 0o600);
});

// ── 鍵の名前 ──────────────────────────────────────────────────────────────

test("🔑 出荷時の Gemini は旧名の鍵も見る（版を上げて鍵が消えたように見えるのを防ぐ）", () => {
  assert.deepEqual(providers.secretKeyCandidates("gemini-public"),
    ["ai.provider.gemini-public.apiKey", "ai.gemini.apiKey"]);
  // 他の提供元に旧名は使わせない（1 つの鍵を共用させない）。
  assert.deepEqual(providers.secretKeyCandidates("azure-hosp"), ["ai.provider.azure-hosp.apiKey"]);
});

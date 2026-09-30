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
  assert.ok(r.problems.some((p) => p.includes("capability-not-supported")));
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

// ── 段 5a: 「どの AI が来ても足せる」ための検査 ─────────────────────────────
//
// 🔑 ここで守るのは「**設定で足せる範囲を広げても、送り先が意図から外れない**」こと。
// 広げた項目（auth / headers / paths / apiVersion / pathStyle）はすべて患者画素の
// **宛先か中身**に触るので、検査はこの 1 ファイルが正本（送信側に書き写さない）。

const OA = {
  id: "oa", kind: "openai", endpoint: "https://api.openai.test",
  models: { "image-to-text": "gpt-4o-mini" },
};
/** 1 件だけ検査して、通ったものと理由を返す。 */
function one(over) {
  const r = providers.normalize({ providers: [{ ...OA, ...over }] });
  return { provider: r.providers[0], problems: r.problems };
}

// ── エンドポイント ────────────────────────────────────────────────────────

test("🔴 endpoint にパスを書かせない（黙って捨てると別の場所へ送る形になる）", () => {
  // 以前は通り、送出側は host しか見ないので `/v1` が消えていた。
  assert.equal(one({ endpoint: "https://api.test/v1" }).provider, undefined);
  assert.ok(one({ endpoint: "https://api.test/v1" }).problems[0].includes("endpoint-has-path"));
  // 末尾スラッシュだけなら「パス無し」として通す。
  assert.equal(one({ endpoint: "https://api.test/" }).provider.endpoint, "https://api.test");
});

test("🔴 endpoint の認証情報・クエリ・断片を拒む", () => {
  for (const [bad, code] of [
    ["https://user:pass@api.test", "endpoint-has-credentials"],
    ["https://api.test?key=abc", "endpoint-has-query"],
    ["https://api.test#x", "endpoint-has-fragment"],
    ["ftp://api.test", "endpoint-scheme"],
    ["api.test", "endpoint-unparsable"],
  ]) {
    const r = one({ endpoint: bad });
    assert.equal(r.provider, undefined, bad);
    assert.ok(r.problems.some((p) => p.includes(code)), `${bad} → ${code} / 実際: ${r.problems}`);
  }
});

test("🔑 ポートを保つ（自院ホストの互換サーバが主目的）", () => {
  assert.equal(one({ endpoint: "https://ai.hosp.local:8443" }).provider.endpoint, "https://ai.hosp.local:8443");
  // 既定ポートは URL の正規化で落ちる（付けても付けなくても同じ宛先）。
  assert.equal(one({ endpoint: "https://api.test:443" }).provider.endpoint, "https://api.test");
});

test("🔴 平文 http は院内だけ（公開ホストへ患者画素を平文で出さない）", () => {
  const ok = ["http://localhost:11434", "http://127.0.0.1:8000", "http://[::1]:8000",
              "http://10.1.2.3", "http://172.20.0.5", "http://192.168.1.9:11434",
              "http://aiserver:8000", "http://gpu.hosp.local", "http://x.internal"];
  for (const e of ok) {
    const r = one({ endpoint: e });
    assert.ok(r.provider, `院内として許すはず: ${e} / ${r.problems}`);
    assert.equal(r.provider.plaintext, true, `平文の印が要る: ${e}`);
  }
  const ng = ["http://api.openai.com", "http://8.8.8.8", "http://example.test", "http://api.x.ai:443"];
  for (const e of ng) {
    const r = one({ endpoint: e });
    assert.equal(r.provider, undefined, `許してはいけない: ${e}`);
    assert.ok(r.problems.some((p) => p.includes("endpoint-plain-http")));
  }
});

test("https には平文の印を付けない", () => {
  assert.equal(one({}).provider.plaintext, undefined);
});

// ── 認証 ──────────────────────────────────────────────────────────────────

test("🔑 認証ヘッダ名と接頭辞を設定で変えられる（既定はアダプタが持つ）", () => {
  const p = one({ auth: { header: "X-Api-Key", prefix: "" } }).provider;
  assert.deepEqual(p.auth, { header: "x-api-key", prefix: "" }, "小文字で保存する");
  // 未指定ならアダプタの既定に任せる（値を作らない）。
  assert.equal(one({}).provider.auth, undefined);
});

test("旧い形（\"auth\": \"api-key\"）を受け付け続ける", () => {
  assert.equal(one({ auth: "api-key" }).provider.auth, "api-key");
  assert.equal(one({ auth: "oauth" }).provider, undefined);
});

test("🔴 認証ヘッダに電文の骨格を壊す名前は入れない", () => {
  for (const bad of ["Host", "content-length", "content-type", "transfer-encoding", "connection"]) {
    assert.equal(one({ auth: { header: bad } }).provider, undefined, bad);
  }
  // 逆に、認証として当然使う名前は許す。
  for (const good of ["authorization", "api-key", "x-goog-api-key"]) {
    assert.ok(one({ auth: { header: good } }).provider, good);
  }
});

// ── 追加ヘッダ（UI には出さない。JSON を手で書く人のため） ──────────────────

test("🔴 追加ヘッダに鍵を書かせない（設定ファイルは暗号化されていない）", () => {
  for (const secret of ["sk-abcdefgh1234", "AIzaSyABCDEFGHIJ", "Bearer abc123",
                        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]) {
    const r = one({ headers: { "x-token": secret } });
    assert.equal(r.provider.headers, undefined, secret);
    assert.ok(r.problems.some((p) => p.includes("header-looks-like-secret")));
  }
});

test("🔴 追加ヘッダで宛先と電文の形を変えられない", () => {
  // Host を差し替えられると、同意ダイアログの送信先と実際の宛先が乖離する。
  for (const bad of ["Host", "Content-Type", "Content-Length", "Authorization", "x-api-key",
                     "proxy-authorization", "transfer-encoding"]) {
    const r = one({ headers: { [bad]: "v" } });
    assert.equal(r.provider.headers, undefined, bad);
    assert.ok(r.problems.some((p) => p.includes("header-not-allowed")), bad);
  }
});

test("🔴 ヘッダ値に CR/LF を入れられない（送信時ではなく保存時に弾く）", () => {
  // 送信時にも Node が弾くが、それでは「保存はできるが送信だけ失敗する設定」が作れる。
  for (const bad of ["a\r\nX-Evil: 1", "a\nb", "a\tb", "日本語"]) {
    const r = one({ headers: { "x-foo": bad } });
    assert.equal(r.provider.headers, undefined, JSON.stringify(bad));
    assert.ok(r.problems.some((p) => p.includes("header-value")));
  }
});

test("大小違いの重複ヘッダを弾く（送出時に後勝ちになるため）", () => {
  const r = one({ headers: { "X-Foo": "1", "x-foo": "2" } });
  assert.ok(r.problems.some((p) => p.includes("header-duplicate")));
});

test("通る追加ヘッダは小文字で保存される", () => {
  assert.deepEqual(one({ headers: { "OpenAI-Beta": "assistants=v2" } }).provider.headers,
    { "openai-beta": "assistants=v2" });
});

// ── パスの上書き ──────────────────────────────────────────────────────────

test("🔑 用途ごとにパスを上書きできる（OpenRouter や互換口のため）", () => {
  const p = one({ paths: { "image-to-text": "/api/v1/chat/completions" } }).provider;
  assert.deepEqual(p.paths, { "image-to-text": "/api/v1/chat/completions" });
});

test("🔴 パスの危ない形を拒む", () => {
  for (const [bad, code] of [
    ["v1/chat", "path-not-absolute"],
    ["//evil.test/x", "path-protocol-relative"],
    ["/v1/../admin", "path-dotdot"],
    ["/v1/chat?a=b", "path-has-query"],
    ["/v1/%2e%2e/x", "path-has-escape"],
    ["https://evil.test/x", "path-not-absolute"],
    ["/v1/{model}/chat", "path-chars"],
  ]) {
    const r = one({ paths: { "image-to-text": bad } });
    assert.equal(r.provider.paths, undefined, bad);
    assert.ok(r.problems.some((p) => p.includes(code)), `${bad} → ${code} / 実際: ${r.problems}`);
  }
});

test("モデルの無い用途にパスだけ書くのは矛盾として弾く", () => {
  const r = one({ paths: { "image-to-image": "/v1/images/edits" } });
  assert.equal(r.provider.paths, undefined);
  assert.ok(r.problems.some((p) => p.includes("path-without-model")));
});

// ── pathStyle / apiVersion ────────────────────────────────────────────────

test("🔑 apiVersion を提供元の設定に持てる（Azure の版指定が組み込み固定だった）", () => {
  assert.equal(one({ apiVersion: "2025-01-01" }).provider.apiVersion, "2025-01-01");
  assert.equal(one({ apiVersion: "v1beta" }).provider.apiVersion, "v1beta");
});

test("🔴 apiVersion に .. を入れられない（URL のパス要素に入る）", () => {
  for (const bad of ["v1..beta", "../v1", "a b", "x".repeat(40)]) {
    assert.equal(one({ apiVersion: bad }).provider, undefined, bad);
  }
});

test("pathStyle は既知の 2 つだけ", () => {
  assert.equal(one({ pathStyle: "azure-deployment" }).provider.pathStyle, "azure-deployment");
  assert.equal(one({ pathStyle: "openai" }).provider.pathStyle, "openai");
  assert.equal(one({ pathStyle: "responses" }).provider, undefined);
});

// ── 知らない項目・版 ──────────────────────────────────────────────────────

test("🔴 知らない項目は黙って消さない（save が正規化結果を書き戻すため）", () => {
  const r = one({ timeoutMs: 5000, proxy: "http://p" });
  assert.equal(r.provider.timeoutMs, undefined, "受け入れない");
  assert.ok(r.problems.some((p) => p.includes("ignored-field:timeoutMs")));
  assert.ok(r.problems.some((p) => p.includes("ignored-field:proxy")));
});

test("未来の版のファイルは「新しすぎる」と言う（黙って一部だけ読まない）", () => {
  const r = providers.normalize({ schemaVersion: 99, providers: [OA] });
  assert.ok(r.problems.some((p) => p.includes("schema-too-new")));
});

test("保存したファイルに版が入る", () => {
  const dir = freshDir();
  const p = freshStore(dir);
  p.save({ providers: [OA] });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, p.FILE_NAME), "utf8"));
  assert.equal(saved.schemaVersion, providers.SCHEMA_VERSION);
  // 実行時にだけ意味のある項目は保存しない（endpoint から毎回決まる）。
  assert.equal("plaintext" in saved.providers[0], false);
});

// ── 読み込み失敗を黙らせない ──────────────────────────────────────────────

test("🔴 JSON が壊れていたら problems に出す（画面に出す材料が無いと原因不明の沈黙になる）", () => {
  const dir = freshDir();
  // いちばん多い壊れ方: JSON にコメントを書く。
  fs.writeFileSync(path.join(dir, providers.FILE_NAME), '{ "providers": [] } // メモ');
  const p = freshStore(dir);
  const c = p.get();
  assert.ok(c.problems.some((x) => x.startsWith("config:parse-error")), `実際: ${c.problems}`);
  assert.equal(p.resolve("image-to-image").ok, true, "出荷時の構成で動き続ける");
});

test("使える提供元が 1 つも無いとき、戻したことを problems に残す", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, providers.FILE_NAME),
    JSON.stringify({ providers: [{ ...OA, endpoint: "http://api.openai.com" }] }));
  const p = freshStore(dir);
  const c = p.get();
  assert.ok(c.problems.some((x) => x.includes("endpoint-plain-http")), "捨てた理由が残る");
  assert.ok(c.problems.some((x) => x.includes("fell-back-to-built-in")));
});

// ── 接続テストの下ごしらえ ────────────────────────────────────────────────

test("🔑 id で 1 件引ける（既定でない提供元も接続テストの対象にする）", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, providers.FILE_NAME), JSON.stringify({ providers: [GEMINI, OA] }));
  const p = freshStore(dir);
  assert.equal(p.byId("oa").endpoint, "https://api.openai.test");
  assert.equal(p.byId("nope"), null);
  assert.equal(p.byId("../etc"), null, "形の検査を通す");
});

test("検査だけして書かない口がある（設定画面が入力中に叩く）", () => {
  const dir = freshDir();
  const p = freshStore(dir);
  const r = p.validate({ providers: [{ ...OA, endpoint: "https://api.test/v1" }] });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => x.includes("endpoint-has-path")));
  assert.equal(fs.existsSync(path.join(dir, p.FILE_NAME)), false, "書いていないこと");
});

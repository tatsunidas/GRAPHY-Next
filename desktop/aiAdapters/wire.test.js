// `node --test`。設計: fw/ai-routing-design.md §14
//
// 🔑 この 3 つの部品が守るのは「**設定で足せる範囲を広げても、認証と宛先が意図から外れない**」こと。

const test = require("node:test");
const assert = require("node:assert");
const wire = require("./wire");

const FALLBACK = { header: "Authorization", prefix: "Bearer " };

test("既定の認証ヘッダを使う", () => {
  assert.deepEqual(wire.authHeaders({}, "KEY", FALLBACK), { Authorization: "Bearer KEY" });
});

test("🔑 設定でヘッダ名と接頭辞を変えられる", () => {
  assert.deepEqual(wire.authHeaders({ auth: { header: "api-key", prefix: "" } }, "KEY", FALLBACK),
    { "api-key": "KEY" });
});

test("🔴 prefix: \"\" を「未指定」と取り違えない", () => {
  // `||` で既定へ落とすと、接頭辞を消したい人の意図を無視して "Bearer " が付く。
  assert.deepEqual(wire.authHeaders({ auth: { header: "x-api-key", prefix: "" } }, "K", FALLBACK),
    { "x-api-key": "K" });
});

test("旧い形（文字列の auth）でも既定に落ちる", () => {
  assert.deepEqual(wire.authHeaders({ auth: "api-key" }, "KEY", FALLBACK), { Authorization: "Bearer KEY" });
});

test("パスは設定があればそちらを使う", () => {
  assert.equal(wire.pathFor({}, "image-to-text", "/v1/chat/completions"), "/v1/chat/completions");
  assert.equal(
    wire.pathFor({ paths: { "image-to-text": "/api/v1/chat/completions" } }, "image-to-text", "/v1/chat/completions"),
    "/api/v1/chat/completions",
  );
  // 別の用途の上書きは効かない。
  assert.equal(wire.pathFor({ paths: { "image-to-image": "/x" } }, "image-to-text", "/v1/c"), "/v1/c");
});

test("🔴 追加ヘッダは認証と Content-Type を上書きできない（大小を無視して突き合わせる）", () => {
  const own = { "Content-Type": "application/json", Authorization: "Bearer REAL" };
  const merged = wire.mergeHeaders(own, {
    "authorization": "Bearer EVIL",
    "content-type": "text/plain",
    "openai-beta": "assistants=v2",
  });
  assert.equal(merged.Authorization, "Bearer REAL");
  assert.equal(merged["Content-Type"], "application/json");
  assert.equal(merged.authorization, undefined, "大小違いのキーを残さない");
  assert.equal(merged["openai-beta"], "assistants=v2", "衝突しないものは通る");
});

test("追加ヘッダが無ければそのまま返す", () => {
  const own = { "Content-Type": "application/json" };
  assert.equal(wire.mergeHeaders(own, undefined), own);
});

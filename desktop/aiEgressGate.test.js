const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createGate } = require("./aiEgressGate");

const PLUGINS = {
  art: { id: "art", name: "Art", permissions: ["ai-egress"] },
  noperm: { id: "noperm", name: "NoPerm", permissions: ["ai-tools"] },
};
const EXTERNAL = { ok: true, providerId: "gem", label: "Gemini", endpointHost: "g.example", model: "m1", local: false };
const LOCAL = { ok: true, providerId: "loc", label: "Local", endpointHost: "127.0.0.1:8080", model: "m", local: true };

function make({ plan = EXTERNAL, answer = { ok: true }, confirmThrows = false } = {}) {
  const confirms = [];
  const audits = [];
  const gate = createGate({
    lookupPlugin: async (id) => PLUGINS[id] || null,
    resolve: () => plan,
    confirm: async (info) => {
      confirms.push(info);
      if (confirmThrows) throw new Error("boom");
      return answer;
    },
    audit: (l) => audits.push(l),
  });
  return { gate, confirms, audits };
}
const req = (extra = {}) => ({ capability: "image-to-image", prompt: "draw\nme", imageBase64: "QUJD", claimedPluginId: "art", scopeKey: "s1", ...extra });

test("外部宛て: 確認を出し、承認で通る。自己申告フィールドは転送しない", async () => {
  const { gate, confirms, audits } = make();
  const r = await gate.check(req());
  assert.equal(r.ok, true);
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].host, "g.example");
  assert.equal(confirms[0].prompt, "draw me");
  assert.ok(!("claimedPluginId" in r.req) && !("scopeKey" in r.req));
  assert.equal(audits.length, 1);
  assert.ok(!audits[0].includes("draw") && !audits[0].includes("QUJD"), "本文を残さない");
});

test("🔴 拒否・例外・不正な返り値では通らず、監査も出ない", async () => {
  for (const o of [{ answer: { ok: false } }, { confirmThrows: true }, { answer: null }, { answer: { ok: "yes" } }]) {
    const { gate, audits } = make(o);
    const r = await gate.check(req());
    assert.deepEqual(r, { ok: false, error: "canceled" });
    assert.equal(audits.length, 0);
  }
});

test("🔴 pluginId なし・未知・権限なしは確認の前に拒否", async () => {
  for (const id of [undefined, "", "nobody", "noperm", 5]) {
    const { gate, confirms } = make();
    const r = await gate.check(req({ claimedPluginId: id }));
    assert.deepEqual(r, { ok: false, error: "unknown-caller" });
    assert.equal(confirms.length, 0);
  }
});

test("lookup が例外でも unknown-caller", async () => {
  const gate = createGate({ lookupPlugin: async () => { throw new Error("x"); }, resolve: () => EXTERNAL, confirm: async () => ({ ok: true }), audit() {} });
  assert.deepEqual(await gate.check(req()), { ok: false, error: "unknown-caller" });
});

test("ローカル宛ては確認なしで通り、監査は残る", async () => {
  const { gate, confirms, audits } = make({ plan: LOCAL });
  assert.equal((await gate.check(req())).ok, true);
  assert.equal(confirms.length, 0);
  assert.match(audits[0], /local=true/);
});

test("local が真でない(欠落)なら外部扱い", async () => {
  const { gate, confirms } = make({ plan: { ...EXTERNAL, local: undefined } });
  await gate.check(req());
  assert.equal(confirms.length, 1);
});

test("remember: 同一スコープは再確認なし、別スコープ・別 scopeKey なしは再確認", async () => {
  const { gate, confirms } = make({ answer: { ok: true, remember: true } });
  await gate.check(req());
  await gate.check(req());
  assert.equal(confirms.length, 1);
  await gate.check(req({ scopeKey: "s2" }));
  assert.equal(confirms.length, 2);
  await gate.check(req({ scopeKey: undefined }));
  await gate.check(req({ scopeKey: undefined }));
  assert.equal(confirms.length, 4, "scopeKey なしは覚えない");
  gate.forget();
  await gate.check(req());
  assert.equal(confirms.length, 5);
});

test("解決できない用途は確認の前に返す", async () => {
  const { gate, confirms } = make({ plan: { ok: false, error: "no-provider" } });
  assert.deepEqual(await gate.check(req()), { ok: false, error: "no-provider" });
  assert.equal(confirms.length, 0);
});

test("空・非オブジェクトの要求", async () => {
  const { gate } = make();
  assert.deepEqual(await gate.check(null), { ok: false, error: "empty-request" });
});

test("🔴 鍵が無ければ確認の前に no-api-key", async () => {
  const { gate, confirms, audits } = make({ plan: { ...EXTERNAL, hasApiKey: false } });
  assert.deepEqual(await gate.check(req()), { ok: false, error: "no-api-key" });
  assert.equal(confirms.length, 0);
  assert.equal(audits.length, 0);
});

test("🔴 確認に出すモデルは generate が使うモデル(用途ありなら解決結果、呼び出し側の指定ではない)", async () => {
  const a = make();
  await a.gate.check(req({ model: "evil-expensive" }));
  assert.equal(a.confirms[0].model, "m1");
  const b = make();
  await b.gate.check(req({ capability: undefined, model: "legacy-m" }));
  assert.equal(b.confirms[0].model, "legacy-m");
});

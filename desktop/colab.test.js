// `node --test`。Colab（ログイン・API・ランタイム）。設計: fw/remote-compute-design.md §15
//
// 本物の Google には繋がない（fetch を差し替える）。ログインの loopback だけは本物の http で受ける。
// 🔴 electron を import しない（CI の Desktop ジョブは npm install しない）。

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createColabAuth, REFRESH_KEY } = require("./colabAuth");
const { createColabApi, ColabError } = require("./colabApi");
const { createColabRuntimes, REFRESH_BEFORE_MS } = require("./colabRuntimes");

function memSecrets() {
  const m = new Map();
  return {
    getSecret: (k) => m.get(k) ?? null,
    setSecret: (k, v) => (m.set(k, v), { ok: true, persisted: true }),
    clearSecret: (k) => m.delete(k),
    map: m,
  };
}

function clientDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "graphy-colab-"));
  fs.writeFileSync(path.join(d, "colab-oauth-client.json"),
    JSON.stringify({ installed: { client_id: "cid.apps.googleusercontent.com", client_secret: "csecret" } }));
  return d;
}

const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;

// ── ログイン ────────────────────────────────────────────────────────────────
test("ログイン: ブラウザ → loopback で code を受け、PKCE と state を確かめ、refresh token を預ける", async () => {
  const secrets = memSecrets();
  let tokenReq = null;
  const auth = createColabAuth({
    dirs: [clientDir()],
    secrets,
    fetch: async (url, init) => {
      tokenReq = Object.fromEntries(new URLSearchParams(init.body.toString()));
      return json(200, { access_token: "AT", refresh_token: "RT", expires_in: 3600, id_token: idToken("dr@example.org"),
        scope: "openid https://www.googleapis.com/auth/colaboratory" });
    },
    // 利用者のブラウザの代わり: 認可 URL を読み、loopback へ code と state を返す
    openExternal: (url) => {
      const u = new URL(url);
      assert.strictEqual(u.searchParams.get("code_challenge_method"), "S256");
      assert.strictEqual(u.searchParams.get("access_type"), "offline");
      assert.ok(u.searchParams.get("scope").includes("auth/colaboratory"));
      const redirect = u.searchParams.get("redirect_uri");
      assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+$/);
      void fetch(`${redirect}/?code=CODE&state=${u.searchParams.get("state")}`);
    },
  });
  assert.strictEqual(auth.signedIn(), false);
  const r = await auth.signIn();
  assert.deepStrictEqual(r, { ok: true, email: "dr@example.org" });
  assert.strictEqual(tokenReq.code, "CODE");
  assert.ok(tokenReq.code_verifier && tokenReq.code_verifier.length >= 43, "PKCE の verifier を送る");
  assert.strictEqual(secrets.getSecret(REFRESH_KEY), "RT");
  assert.strictEqual(await auth.accessToken(), "AT");
});

test("ログイン: state が違えば受け付けない・Colab の権限を外されたら失敗にする", async () => {
  const mk = (scope, badState) => createColabAuth({
    dirs: [clientDir()],
    secrets: memSecrets(),
    fetch: async () => json(200, { access_token: "AT", refresh_token: "RT", expires_in: 3600, scope }),
    openExternal: (url) => {
      const u = new URL(url);
      void fetch(`${u.searchParams.get("redirect_uri")}/?code=C&state=${badState ? "forged" : u.searchParams.get("state")}`);
    },
  });
  assert.strictEqual((await mk("openid https://www.googleapis.com/auth/colaboratory", true).signIn()).error, "state-mismatch");
  assert.strictEqual((await mk("openid email", false).signIn()).error, "scope-not-granted");
});

test("アクセストークン: refresh token で取り直す・取り消されていたら refresh token を捨てる", async () => {
  const secrets = memSecrets();
  secrets.setSecret(REFRESH_KEY, "RT");
  let answer = json(200, { access_token: "AT2", expires_in: 3600 });
  const auth = createColabAuth({ dirs: [clientDir()], secrets, openExternal: () => {}, fetch: async () => answer });
  assert.strictEqual(await auth.accessToken(), "AT2");
  const auth2 = createColabAuth({ dirs: [clientDir()], secrets, openExternal: () => {}, fetch: async () => json(400, { error: "invalid_grant" }) });
  assert.strictEqual(await auth2.accessToken(), null);
  assert.strictEqual(secrets.getSecret(REFRESH_KEY), null, "7 日切れ・取り消し → ログインし直し");
});

test("クライアントの設定が無ければログインしない", async () => {
  const auth = createColabAuth({ dirs: [fs.mkdtempSync(path.join(os.tmpdir(), "graphy-colab-none-"))], secrets: memSecrets(), openExternal: () => assert.fail("開かない") });
  assert.strictEqual(auth.configured(), false);
  assert.strictEqual((await auth.signIn()).error, "no-oauth-client");
});

// ── API ────────────────────────────────────────────────────────────────────
function fakeApi(handler) {
  const calls = [];
  const api = createColabApi(async () => "AT", async (url, init) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.pathname}`);
    assert.strictEqual(init.headers.Authorization, "Bearer AT");
    return handler(init.method, u.pathname + u.search, init.body ? JSON.parse(init.body) : null);
  });
  return { api, calls };
}

test("API: ランタイムの確保は LRO を :wait で待ち、response を返す", async () => {
  let waits = 0;
  const { api, calls } = fakeApi((m, p, body) => {
    if (m === "POST") {
      assert.deepStrictEqual(body, { runtimeSpec: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" } });
      assert.match(p, /^\/v1beta\/runtimes\?requestId=[0-9a-f-]{36}$/);
      return json(200, { name: "operations/op-1", done: false });
    }
    waits++;
    return json(200, waits < 2 ? { name: "operations/op-1", done: false }
      : { name: "operations/op-1", done: true, response: { name: "runtimes/r-1", connectionInfo: { url: "https://x.prod.colab.dev", token: "T", expireTime: "2026-10-03T01:30:00Z" } } });
  });
  const rt = await api.createRuntime({ variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" });
  assert.strictEqual(rt.name, "runtimes/r-1");
  assert.deepStrictEqual(calls, ["POST /v1beta/runtimes", "GET /v1/operations/op-1:wait", "GET /v1/operations/op-1:wait"]);
});

test("API: Operation のエラーを理由のコードにする（GPU の在庫切れ・同時数・利用枠）", async () => {
  const fail = (error) => fakeApi(() => json(200, { name: "operations/x", done: true, error })).api;
  const gpu = { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" };
  await assert.rejects(fail({ code: 9, message: "no" }).createRuntime(gpu), (e) => e.code === "gpu-unavailable");
  await assert.rejects(fail({ code: 8, details: [{ reason: "TOO_MANY_ACTIVE_RUNTIMES" }] }).createRuntime(gpu), (e) => e.code === "too-many-runtimes");
  await assert.rejects(fail({ code: 8, details: [{ reason: "QUOTA_EXCEEDED_USAGE_TIME" }] }).createRuntime(gpu), (e) => e.code === "quota-exceeded");
  await assert.rejects(fail({ code: 9 }).createRuntime({ ...gpu, variant: "VARIANT_CPU", accelerator: "NONE" }), (e) => e.code === "operation-9");
});

test("API: ランタイムの名前の形を確かめる（パスに混ぜない）・401 は http-401", async () => {
  const { api } = fakeApi(() => json(401, { error: { message: "expired" } }));
  assert.throws(() => api.getRuntime("runtimes/../x"), ColabError);
  await assert.rejects(api.getRuntime("runtimes/r-1"), (e) => e.code === "http-401");
  const specs = fakeApi(() => json(200, { runtimeSpecs: [{ key: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" }, eligible: true }, { key: { variant: "VARIANT_GPU", accelerator: "A100", shape: "SHAPE_STANDARD" } }] })).api;
  assert.deepStrictEqual((await specs.runtimeSpecs()).map((s) => `${s.accelerator}:${s.eligible}`), ["T4:true", "A100:false"]);
});

// ── ランタイム ──────────────────────────────────────────────────────────────
function fakeTimers() {
  const t = { now: 0, queue: [] };
  return {
    t,
    timers: {
      now: () => t.now,
      setTimeout: (fn, ms) => (t.queue.push({ at: t.now + ms, fn }), t.queue.length),
      clearTimeout: (h) => { if (t.queue[h - 1]) t.queue[h - 1].fn = null; },
    },
    async advance(ms) {
      t.now += ms;
      for (const q of t.queue) if (q.fn && q.at <= t.now) { const f = q.fn; q.fn = null; await f(); }
      await new Promise((r) => setImmediate(r));
    },
  };
}

test("ランタイム: 確保は 1 回・期限の 5 分前にトークンを取り直して入れ直す・解放", async () => {
  const ft = fakeTimers();
  let pushes = 0;
  let tokenNo = 1;
  const deleted = [];
  const api = {
    createRuntime: async () => ({ name: "runtimes/r-1", connectionInfo: { url: "https://x.prod.colab.dev", token: "T1", expireTime: new Date(3600_000).toISOString() } }),
    getRuntime: async () => ({ connectionInfo: { url: "https://x.prod.colab.dev", token: `T${++tokenNo}`, expireTime: new Date(7200_000).toISOString() } }),
    deleteRuntime: async (n) => deleted.push(n),
  };
  const rts = createColabRuntimes(api, async () => { pushes++; }, ft.timers);
  const spec = { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" };
  const [a, b] = await Promise.all([rts.ensure("colab", "Colab T4", spec), rts.ensure("colab", "Colab T4", spec)]);
  assert.strictEqual(a.allocated, true);
  assert.strictEqual(b.name, "runtimes/r-1", "同時に呼んでも 1 つだけ作る");
  assert.strictEqual(rts.endpoints()[0].token, "T1");
  assert.strictEqual(JSON.stringify(rts.status("colab")).includes("T1"), false, "🔴 状態にトークンを出さない");
  await ft.advance(3600_000 - REFRESH_BEFORE_MS - 1);
  assert.strictEqual(rts.endpoints()[0].token, "T1", "まだ取り直さない");
  await ft.advance(2);
  assert.strictEqual(rts.endpoints()[0].token, "T2", "期限の 5 分前に取り直す");
  assert.ok(pushes >= 2, "取り直したら backend へ入れ直す");
  await rts.releaseAll();
  assert.deepStrictEqual(deleted, ["runtimes/r-1"]);
  assert.deepStrictEqual(rts.endpoints(), []);
});

test("ランタイム: Colab が回収していたら（not-found）捨てる", async () => {
  const ft = fakeTimers();
  const api = {
    createRuntime: async () => ({ name: "runtimes/r-2", connectionInfo: { url: "https://x", token: "T", expireTime: new Date(600_000).toISOString() } }),
    getRuntime: async () => { throw Object.assign(new Error("gone"), { code: "not-found" }); },
    deleteRuntime: async () => {},
  };
  const rts = createColabRuntimes(api, async () => {}, ft.timers);
  await rts.ensure("c", "C", { variant: "VARIANT_CPU", accelerator: "NONE", shape: "SHAPE_STANDARD" });
  await ft.advance(600_000);
  assert.deepStrictEqual(rts.status("c"), { allocated: false });
});

test("メールアドレス: 保存したログインで起動し直したら userinfo で引き直す", async () => {
  const secrets = memSecrets();
  secrets.setSecret(REFRESH_KEY, "RT");
  const auth = createColabAuth({
    dirs: [clientDir()], secrets, openExternal: () => {},
    fetch: async (url) => String(url).includes("userinfo")
      ? json(200, { email: "dr@example.org" })
      : json(200, { access_token: "AT", expires_in: 3600 }),  // refresh では id_token が付かないことがある
  });
  assert.strictEqual(auth.email(), null);
  assert.strictEqual(await auth.ensureEmail(), "dr@example.org");
});

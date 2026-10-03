// `node --test`。既定の計算機（Colab の GPU T4）。設計: fw/remote-compute-design.md §17
// 🔴 electron を import しない（CI の Desktop ジョブは npm install しない）。

const test = require("node:test");
const assert = require("node:assert");

const { ensureDefaultEndpoint, pickDefault, DEFAULT_ID, DEFAULT_SPEC } = require("./computeDefault");

function memEndpoints(initial = [], problems = []) {
  let cfg = { endpoints: initial, problems };
  const saved = [];
  return {
    get: () => cfg,
    save: (raw) => {
      saved.push(raw);
      cfg = { endpoints: raw.endpoints, problems: [] };
      return { ok: true, problems: [] };
    },
    saved,
  };
}

const auth = (signedIn, configured = true) => ({ configured: () => configured, signedIn: () => signedIn });
const api = (specs) => ({ runtimeSpecs: async () => specs });
const T4 = { ...DEFAULT_SPEC, eligible: true };
const CPU = { variant: "VARIANT_CPU", accelerator: "NONE", shape: "SHAPE_STANDARD", eligible: true };

test("未登録・ログイン済み・T4 が使える → Colab の T4 を 1 本足す", async () => {
  const endpoints = memEndpoints();
  const r = await ensureDefaultEndpoint({ endpoints, colabAuth: auth(true), colabApi: api([CPU, T4]) });
  assert.deepStrictEqual(r, { ok: true, endpointId: DEFAULT_ID, added: true });
  assert.strictEqual(endpoints.saved.length, 1);
  assert.deepStrictEqual(endpoints.saved[0].endpoints, [
    { id: "colab-t4", label: "Google Colab（GPU T4）", kind: "colab", spec: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" } },
  ]);
});

test("既に計算機があれば足さない（利用者が選んだものを変えない）", async () => {
  const endpoints = memEndpoints([{ id: "lab", label: "Lab", kind: "jupyter", url: "https://lab.example" }]);
  const r = await ensureDefaultEndpoint({ endpoints, colabAuth: auth(true), colabApi: api([T4]) });
  assert.deepStrictEqual(r, { ok: true, endpointId: "lab", added: false });
  assert.strictEqual(endpoints.saved.length, 0);
});

test("未ログイン・OAuth の設定が無い・T4 が使えない → 足さずに理由を返す（CPU に落とさない）", async () => {
  assert.deepStrictEqual(await ensureDefaultEndpoint({ endpoints: memEndpoints(), colabAuth: auth(false), colabApi: api([T4]) }),
    { ok: false, error: "colab-signin-required" });
  assert.deepStrictEqual(await ensureDefaultEndpoint({ endpoints: memEndpoints(), colabAuth: auth(true, false), colabApi: api([T4]) }),
    { ok: false, error: "colab-not-configured" });
  assert.deepStrictEqual(await ensureDefaultEndpoint({ endpoints: memEndpoints(), colabAuth: null, colabApi: api([T4]) }),
    { ok: false, error: "colab-not-configured" });
  const noT4 = memEndpoints();
  assert.deepStrictEqual(await ensureDefaultEndpoint({ endpoints: noT4, colabAuth: auth(true), colabApi: api([CPU, { ...T4, eligible: false }]) }),
    { ok: false, error: "t4-not-available" });
  assert.strictEqual(noT4.saved.length, 0);
});

test("設定のファイルが読めないときは上書きしない", async () => {
  const endpoints = memEndpoints([], ["config:parse-error:Unexpected token"]);
  const r = await ensureDefaultEndpoint({ endpoints, colabAuth: auth(true), colabApi: api([T4]) });
  assert.deepStrictEqual(r, { ok: false, error: "config-unreadable" });
  assert.strictEqual(endpoints.saved.length, 0);
});

test("既定の選び方: Colab の T4 → トークンの入った最初 → 最初", () => {
  const lab = { id: "lab", kind: "jupyter", hasToken: false };
  const labTok = { id: "lab2", kind: "jupyter", hasToken: true };
  const cpu = { id: "colab-cpu", kind: "colab", hasToken: true, spec: { variant: "VARIANT_CPU", accelerator: "NONE", shape: "SHAPE_STANDARD" } };
  const t4 = { id: "colab-t4", kind: "colab", hasToken: true, spec: { ...DEFAULT_SPEC } };
  assert.strictEqual(pickDefault([lab, labTok, cpu, t4]).id, "colab-t4");
  assert.strictEqual(pickDefault([lab, labTok]).id, "lab2");
  assert.strictEqual(pickDefault([lab]).id, "lab");
});

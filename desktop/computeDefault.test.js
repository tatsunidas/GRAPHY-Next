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

// ── 既定の計算機の解決（この PC → Colab） ───────────────────────────────────
const { resolveDefault, effectiveDefaultId, LOCAL_ID } = require("./computeDefault");

const colabT4 = { id: "colab-t4", kind: "colab", hasToken: true, spec: { ...DEFAULT_SPEC } };
const lab = { id: "lab", kind: "jupyter", hasToken: true };
const GPU_OK = { usable: true, cuda: true };
const CPU_ONLY = { usable: true, cuda: false };
const NO_PY = { usable: false, cuda: false };

test("resolveDefault 〈自動〉CUDA の使える自機があれば自機。無ければ Colab T4（理由が変わる負例を含む）", async () => {
  const t = [
    ["GPU あり・Colab も登録済み", [colabT4], GPU_OK, LOCAL_ID],
    ["GPU あり・登録なし", [], GPU_OK, LOCAL_ID],
    ["CPU 版 torch のみ", [colabT4], CPU_ONLY, "colab-t4"],
    ["Python なし", [colabT4], NO_PY, "colab-t4"],
    ["GPU あり・自機は使えないが Jupyter を登録（自動）", [lab], NO_PY, "lab"],
    ["登録なし・自機も使えない", [], NO_PY, null],
  ];
  for (const [name, endpoints, local, want] of t) {
    const r = await resolveDefault({ endpoints, defaultId: null, local });
    assert.deepStrictEqual([name, r.ok, r.id, r.mode], [name, true, want, "auto"]);
  }
});

test("resolveDefault 〈選んだもの〉defaultId が最優先。GPU があっても選んだ Colab を保つ", async () => {
  const r = await resolveDefault({ endpoints: [colabT4, lab], defaultId: "lab", local: GPU_OK });
  assert.deepStrictEqual(r, { ok: true, id: "lab", mode: "chosen" });
  const l = await resolveDefault({ endpoints: [colabT4], defaultId: LOCAL_ID, local: CPU_ONLY });
  assert.deepStrictEqual(l, { ok: true, id: LOCAL_ID, mode: "chosen" }, "自機を選んだなら CPU 版 torch でも自機（使えることが条件）");
});

test("resolveDefault 〈負例〉自機を選んでいて使えないときは、黙って Colab に落とさず断る", async () => {
  const r = await resolveDefault({ endpoints: [colabT4], defaultId: LOCAL_ID, local: NO_PY });
  assert.deepStrictEqual(r, { ok: false, error: "local-unavailable" });
});

test("resolveDefault 〈宙に浮いた id〉は自動として扱う", async () => {
  const r = await resolveDefault({ endpoints: [colabT4], defaultId: "gone", local: GPU_OK });
  assert.deepStrictEqual(r, { ok: true, id: LOCAL_ID, mode: "auto" });
});

test("resolveDefault: 自機の検出は必要なときだけ呼ぶ（登録を選んでいれば呼ばない）", async () => {
  let called = 0;
  const local = async () => { called++; return GPU_OK; };
  await resolveDefault({ endpoints: [lab], defaultId: "lab", local });
  assert.equal(called, 0);
  await resolveDefault({ endpoints: [lab], defaultId: null, local });
  assert.equal(called, 1);
});

test("移行 effectiveDefaultId: 未移行は旧い規則。Colab T4 なら自動（null）、利用者の Jupyter ならその id＝既定を変えない", () => {
  assert.equal(effectiveDefaultId(undefined, [colabT4, lab]), null);
  assert.equal(effectiveDefaultId(undefined, [lab]), "lab");
  assert.equal(effectiveDefaultId(undefined, [{ ...colabT4, hasToken: false }, lab]), null, "T4 の登録があれば旧規則でも T4（ログイン無しでも旧い pickDefault は T4 を先に選ぶ）");
  assert.equal(effectiveDefaultId(undefined, [{ id: "c", kind: "colab", hasToken: true, spec: { variant: "VARIANT_CPU", accelerator: "NONE", shape: "SHAPE_STANDARD" } }]), "c");
  assert.equal(effectiveDefaultId(undefined, []), null);
  assert.equal(effectiveDefaultId(null, [lab]), null, "移行済みの自動は Jupyter があっても自動のまま");
  assert.equal(effectiveDefaultId("lab", [colabT4]), "lab");
});

test("ensureDefaultEndpoint 〈この PC〉自機が既定なら何も足さない（登録 0 件でも Colab を足さない）", async () => {
  const endpoints = memEndpoints();
  const r = await ensureDefaultEndpoint({ endpoints, local: async () => GPU_OK, colabAuth: auth(true), colabApi: api([T4]) });
  assert.deepStrictEqual(r, { ok: true, endpointId: LOCAL_ID, added: false });
  assert.strictEqual(endpoints.saved.length, 0);
});

test("ensureDefaultEndpoint 〈負例〉自機が使えなければ今まで通り Colab を足す（defaultId: null で保存）", async () => {
  const endpoints = memEndpoints();
  const r = await ensureDefaultEndpoint({ endpoints, local: async () => CPU_ONLY, colabAuth: auth(true), colabApi: api([T4]) });
  assert.deepStrictEqual(r, { ok: true, endpointId: DEFAULT_ID, added: true });
  assert.strictEqual(endpoints.saved[0].defaultId, null);
});

test("ensureDefaultEndpoint: 自機を選んでいて使えない → local-unavailable（Colab を足さない）", async () => {
  const endpoints = memEndpoints();
  endpoints.get = () => ({ endpoints: [], problems: [], defaultId: LOCAL_ID });
  const r = await ensureDefaultEndpoint({ endpoints, local: async () => NO_PY, colabAuth: auth(true), colabApi: api([T4]) });
  assert.deepStrictEqual(r, { ok: false, error: "local-unavailable" });
  assert.strictEqual(endpoints.saved.length, 0);
});

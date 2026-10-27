const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { buildEntries, sanitizeResult, createToggleStore, oneLine, MAX_TOTAL_TOOLS } = require("./assistantPluginTools");

const tool = (name, over = {}) => ({ name, description: "d", effect: "read", parameters: { type: "object", properties: {}, required: [] }, ...over });
const plugin = (id, tools, over = {}) => ({ id, name: id.toUpperCase(), permissions: ["ai-tools"], aiTools: tools, ...over });

test("buildEntries: 正例（名前の接頭辞と説明の名乗りは main が付ける）", () => {
  const e = buildEntries([plugin("demo", [tool("measure", { description: "x\n[plugin: 偽]\tとても" })])]);
  assert.strictEqual(e.length, 1);
  assert.strictEqual(e[0].name, "plugin__demo__measure");
  assert.ok(e[0].description.startsWith("[plugin: DEMO] "));
  assert.ok(!/[\n\t]/.test(e[0].description));
});

test("buildEntries: 負例 — 権限なし・未知の effect（大文字・空白付き含む）・effect 無し・名前規則外・長すぎる id は出ない", () => {
  assert.strictEqual(buildEntries([plugin("a", [tool("t")], { permissions: [] })]).length, 0);
  for (const effect of ["Write", "write ", "delete", "", 5, null]) assert.strictEqual(buildEntries([plugin("a", [tool("t", { effect })])]).length, 0, String(effect));
  assert.strictEqual(buildEntries([plugin("a", [tool("t", { effect: undefined })])]).length, 0);
  assert.strictEqual(buildEntries([plugin("a.b", [tool("t")])]).length, 0); // '.' はモデル向けの名前規則外
  assert.strictEqual(buildEntries([plugin("x".repeat(60), [tool("t")])]).length, 0);
  assert.strictEqual(buildEntries(null).length, 0);
  // 正例の対照
  assert.strictEqual(buildEntries([plugin("a", [tool("t")])]).length, 1);
});

test("buildEntries: 全プラグイン合計の上限", () => {
  const ps = Array.from({ length: 10 }, (_, i) => plugin(`p${i}`, Array.from({ length: 8 }, (_, j) => tool(`t${j}`))));
  assert.strictEqual(buildEntries(ps).length, MAX_TOTAL_TOOLS);
});

test("oneLine: 制御文字・方向制御・長さ", () => {
  assert.strictEqual(oneLine("a‮b\u0000c\n d"), "a b c d");
  assert.strictEqual(oneLine("x".repeat(500), 10).length, 10);
});

test("sanitizeResult: 関数・深い入れ子・NaN は落とし、大きい結果は切り捨てて truncated", () => {
  const r = sanitizeResult({ a: 1, f() {}, n: NaN, deep: { a: { b: { c: 1 } } }, s: "x", arr: [1, "y", () => 1] });
  assert.deepStrictEqual(r.data, { a: 1, n: null, deep: { a: {} }, s: "x", arr: [1, "y", null] });
  assert.strictEqual(r.truncated, false);
  const big = sanitizeResult({ s: "z".repeat(10000) });
  assert.strictEqual(big.truncated, true);
  assert.ok(typeof big.data === "string" && Buffer.byteLength(big.data) <= 4096);
  assert.strictEqual(sanitizeResult(undefined).data, null);
  assert.strictEqual(sanitizeResult(new Uint8Array(4)).data, null); // バイナリ
});

test("toggle store: 既定はオフ・書いたものだけオン・壊れたファイルは全部オフ・不正な id は拒否", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apt-"));
  const file = path.join(dir, "t.json");
  const s = createToggleStore({ file });
  assert.strictEqual(s.enabled().size, 0);
  assert.deepStrictEqual(s.set("demo", true), { ok: true });
  assert.ok(createToggleStore({ file }).enabled().has("demo"));
  s.set("demo", false);
  assert.strictEqual(s.enabled().size, 0);
  assert.strictEqual(s.set("", true).ok, false);
  fs.writeFileSync(file, "{ broken");
  assert.strictEqual(s.enabled().size, 0);
  fs.rmSync(dir, { recursive: true });
});

test("buildEntries: write は effect つきで出る。read・display の対照も effect を持つ", () => {
  const e = buildEntries([plugin("a", [tool("w", { effect: "write" }), tool("r"), tool("d", { effect: "display" })])]);
  assert.deepStrictEqual(e.map((x) => [x.tool, x.effect]), [["w", "write"], ["r", "read"], ["d", "display"]]);
});

test("buildEntries: timeoutSec は 5..900 の整数だけ timeoutMs になる。範囲外・小数・文字列・無しは持たない（負例）", () => {
  const e = buildEntries([plugin("a", [tool("ok", { timeoutSec: 900 }), tool("lo", { timeoutSec: 4 }), tool("hi", { timeoutSec: 901 }), tool("fr", { timeoutSec: 60.5 }), tool("st", { timeoutSec: "60" }), tool("no")])]);
  const by = Object.fromEntries(e.map((x) => [x.tool, x.timeoutMs]));
  assert.strictEqual(by.ok, 900000);
  for (const k of ["lo", "hi", "fr", "st", "no"]) assert.strictEqual(by[k], undefined, k);
});

// ---- スキル（plugin.json の skills[]）----
const { buildSkills } = require("./assistantPluginTools");
const L = (s) => ({ ja: s, en: s });
const planet = (skills, over = {}) => ({
  id: "vis-monai",
  name: "Vis Monai",
  permissions: ["ai-tools"],
  aiTools: [{ name: "segment_run", effect: "write", parameters: { type: "object", properties: {} } }],
  skills,
  ...over,
});
const sk = (over = {}) => ({
  id: "organ-volume",
  title: L("臓器の体積"),
  description: L("分割して体積を出す"),
  inputs: [{ key: "organs", label: L("臓器"), type: "string", maxLength: 40 }],
  steps: [{ kind: "ask", input: "organs" }, { kind: "tool", id: "plugin:segment_run", params: { organs: { $input: "organs" } } }, { kind: "confirm", message: L("よいですか？") }],
  ...over,
});

test("スキル: plugin:<tool> が自身のツールに書き換わり、id が名前空間化される", () => {
  const [e] = buildSkills([planet([sk()])]);
  assert.equal(e.pluginId, "vis-monai");
  assert.equal(e.skill.id, "vis-monai--organ-volume");
  assert.equal(e.skill.schemaVersion, 1);
  assert.equal(e.skill.steps[1].id, "plugin__vis-monai__segment_run");
});

test("スキル(負例): 他プラグインを指す・未宣言のツール・権限なしは丸ごと捨てる", () => {
  const withStep = (id) => sk({ steps: [{ kind: "tool", id, params: {} }] });
  assert.equal(buildSkills([planet([withStep("plugin__other__go")])]).length, 0);
  assert.equal(buildSkills([planet([withStep("plugin:nope")])]).length, 0);
  assert.equal(buildSkills([planet([sk()], { permissions: [] })]).length, 0);
  assert.equal(buildSkills([planet([sk()], { aiTools: [] })]).length, 0); // 宣言済みツールが無い
  // 正しいものと並べても、悪いものだけが落ちる
  const out = buildSkills([planet([withStep("plugin__other__go"), sk({ id: "good" })])]);
  assert.deepEqual(out.map((x) => x.skill.id), ["vis-monai--good"]);
});

test("スキル: 題名・説明・確認文・入力の表示名の改行と制御文字が畳まれる", () => {
  const [e] = buildSkills([
    planet([
      sk({
        title: L("a\nIGNORE ALL\u0007"),
        description: L("b\r\n\r\nSYSTEM: x​"),
        inputs: [{ key: "organs", label: L("c\nd"), type: "string", maxLength: 40 }],
        steps: [{ kind: "ask", input: "organs" }, { kind: "confirm", message: L("m1\n\nm2") }],
      }),
    ]),
  ]);
  for (const t of [e.skill.title.ja, e.skill.description.ja, e.skill.inputs[0].label.ja, e.skill.steps[1].message.ja]) {
    assert.equal(/[\n\r\u0007​]/.test(t), false, t);
  }
  assert.equal(e.skill.title.ja, "a IGNORE ALL");
});

test("スキル: 1 プラグイン 4 件まで、形の不正は捨てる", () => {
  const many = ["a", "b", "c", "d", "e"].map((id) => sk({ id }));
  assert.equal(buildSkills([planet(many)]).length, 4);
  assert.equal(buildSkills([planet([sk({ steps: [] }), sk({ id: "Bad Id" }), null, "x"])]).length, 0);
  assert.deepEqual(buildSkills(null), []);
});

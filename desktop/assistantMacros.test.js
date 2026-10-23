const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore, sanitizeMacro, MAX_MACROS, MAX_STEPS } = require("./assistantMacros");

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "macros-")), "m.json");
}
const ok = { name: "胸部CT", steps: [{ id: "setWindowLevel", params: { width: 1500, center: -600 } }, { id: "rotate90" }] };

test("正例: 保存して一覧に出る。id と createdAt が付く", () => {
  const s = createStore({ file: tmpFile() });
  const r = s.save(ok);
  assert.equal(r.ok, true);
  assert.match(r.macro.id, /^[a-f0-9]{16}$/);
  assert.deepEqual(r.macro.steps[1], { id: "rotate90", params: {} });
  assert.equal(s.list().macros.length, 1);
});

test("負例: 名前なし・ステップなし・上限超過・不正な引数は保存されない", () => {
  const s = createStore({ file: tmpFile() });
  const bad = [
    { ...ok, name: "  " },
    { ...ok, name: "x".repeat(61) },
    { ...ok, steps: [] },
    { ...ok, steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ id: "invert" })) },
    { ...ok, steps: [{ id: "a", params: { o: { x: 1 } } }] },
    { ...ok, steps: [{ id: "a", params: { n: Infinity } }] },
    { ...ok, steps: [{ id: "a".repeat(65) }] },
    { ...ok, steps: [{ params: {} }] },
    null,
  ];
  for (const b of bad) assert.deepEqual(s.save(b), { ok: false, error: "bad-macro" });
  assert.equal(s.list().macros.length, 0);
});

test("個数の上限。同じ id の保存は上書きで、上限に数えない", () => {
  const s = createStore({ file: tmpFile() });
  let last;
  for (let i = 0; i < MAX_MACROS; i++) last = s.save({ ...ok, id: `m${i}` });
  assert.equal(last.ok, true);
  assert.deepEqual(s.save({ ...ok, id: "extra" }), { ok: false, error: "too-many" });
  assert.equal(s.save({ ...ok, id: "m0", name: "改名" }).ok, true);
  assert.equal(s.list().macros.find((m) => m.id === "m0").name, "改名");
});

test("削除。無い id は not-found", () => {
  const s = createStore({ file: tmpFile() });
  const { macro } = s.save(ok);
  assert.deepEqual(s.remove("zzz"), { ok: false, error: "not-found" });
  assert.deepEqual(s.remove(macro.id), { ok: true });
  assert.equal(s.list().macros.length, 0);
});

test("壊れたファイルは空として扱い、次の保存で直る", () => {
  const f = tmpFile();
  fs.writeFileSync(f, "{ not json");
  const s = createStore({ file: f });
  assert.deepEqual(s.list(), { ok: true, macros: [] });
  assert.equal(s.save(ok).ok, true);
  assert.equal(s.list().macros.length, 1);
});

test("手で書き換えられた不正な項目は読み出しで落とす", () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ macros: [{ id: "a", name: "ok", steps: [{ id: "invert" }] }, { id: "b", name: "", steps: [] }, { id: "../c", name: "x", steps: [{ id: "invert" }] }] }));
  const l = createStore({ file: f }).list().macros;
  assert.equal(l.length, 2);
  assert.notEqual(l[1].id, "../c");
});

test("sanitizeMacro: 不正な id は作り直す", () => {
  const m = sanitizeMacro({ ...ok, id: "a/b" }, { newId: () => "gen1" });
  assert.equal(m.id, "gen1");
});

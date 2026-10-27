/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore, sanitizeSkill, MAX_SKILLS, MAX_STEPS } = require("./assistantSkills");

const lt = (s) => ({ ja: s, en: s });
const good = (over = {}) => ({
  schemaVersion: 1,
  id: "s1",
  title: lt("t"),
  description: lt("d"),
  inputs: [{ key: "n", label: lt("n"), type: "integer", min: 0, max: 9, default: 1 }],
  steps: [{ kind: "ask", input: "n" }, { kind: "tool", id: "goToSlice", params: { index: { $input: "n" } } }, { kind: "confirm", message: lt("ok?") }],
  ...over,
});
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skills-")), "s.json");

test("正しい形は通り、余計なキーは捨てられる", () => {
  const s = sanitizeSkill({ ...good(), evil: 1, steps: [{ kind: "tool", id: "resetWindow", params: {}, run: "x" }] });
  assert.ok(s);
  assert.equal(JSON.stringify(s).includes("evil"), false);
  assert.equal(JSON.stringify(s).includes('"run"'), false);
});

test("不正な形は落ちる（負例）", () => {
  const bad = [
    null,
    good({ schemaVersion: 2 }),
    good({ id: "Bad Id" }),
    good({ title: { ja: "x" } }),
    good({ steps: [] }),
    good({ steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ kind: "tool", id: "resetWindow", params: {} })) }),
    good({ steps: [{ kind: "tool", id: "bad id", params: {} }] }),
    good({ steps: [{ kind: "tool", id: "goToSlice", params: { index: { $expr: "1+1" } } }] }),
    good({ steps: [{ kind: "tool", id: "goToSlice", params: { index: { $input: "nope" } } }] }),
    good({ steps: [{ kind: "tool", id: "goToSlice", params: { index: { a: { b: 1 } } } }] }),
    good({ steps: [{ kind: "tool", id: "x", params: { a: "y".repeat(201) } }] }),
    good({ steps: [{ kind: "ask", input: "zzz" }] }),
    good({ steps: [{ kind: "run", cmd: "calc" }] }),
    good({ inputs: [{ key: "n", label: lt("n"), type: "integer", min: 5, max: 1 }] }),
  ];
  for (const b of bad) assert.equal(sanitizeSkill(b), null, JSON.stringify(b)?.slice(0, 80));
});

test("points の配列は通り、形が違えば落ちる", () => {
  assert.ok(sanitizeSkill(good({ steps: [{ kind: "tool", id: "createRoi", params: { points: [[0.1, 0.2], [0.3, 0.4], [0.5, 0.1]] } }] })));
  assert.equal(sanitizeSkill(good({ steps: [{ kind: "tool", id: "createRoi", params: { points: [[0.1, 0.2, 3]] } }] })), null);
});

test("保存・一覧・上書き・削除、上限、書き換えられたファイルは落として読む", () => {
  const file = tmp();
  const st = createStore({ file });
  assert.deepEqual(st.list(), { ok: true, skills: [] });
  assert.equal(st.save(good()).ok, true);
  assert.equal(st.save(good({ title: lt("renamed") })).ok, true);
  assert.equal(st.list().skills.length, 1);
  assert.equal(st.list().skills[0].title.ja, "renamed");
  assert.equal(st.save({ nope: 1 }).error, "bad-skill");
  // 手で書き換えた不正な 1 件は一覧に出ない
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  j.skills.push({ schemaVersion: 1, id: "evil", title: lt("e"), description: lt("e"), inputs: [], steps: [{ kind: "run", cmd: "x" }] });
  fs.writeFileSync(file, JSON.stringify(j));
  assert.deepEqual(st.list().skills.map((s) => s.id), ["s1"]);
  assert.equal(st.remove("s1").ok, true);
  assert.equal(st.remove("s1").error, "not-found");
  for (let i = 0; i < MAX_SKILLS; i++) assert.equal(st.save(good({ id: `k${i}` })).ok, true);
  assert.equal(st.save(good({ id: "over" })).error, "too-many");
});

test("壊れたファイルは空として扱う", () => {
  const file = tmp();
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(createStore({ file }).list(), { ok: true, skills: [] });
});

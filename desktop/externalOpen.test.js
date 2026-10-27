// `node --test`。外部（RIS など）から検査を開く入口の、URL・引数の解釈。外部入力なので、負例を厚くする。
const test = require("node:test");
const assert = require("node:assert");
const { parseUrl, parseArgv, validate } = require("./externalOpen");

const UID = "1.2.840.113619.2.55.3.604688119.971.1234567890.1";
const SER = "1.2.840.113619.2.55.3.604688119.971.1234567890.2";

test("UID だけの URL は、検査 UID の要求になる", () => {
  const r = parseUrl(`graphynext://open?studyInstanceUid=${UID}`);
  assert.deepStrictEqual(r, { ok: true, req: { studyInstanceUid: UID } });
});

test("シリーズ付きの URL", () => {
  const r = parseUrl(`graphynext://open?studyInstanceUid=${UID}&seriesInstanceUid=${SER}`);
  assert.deepStrictEqual(r.req, { studyInstanceUid: UID, seriesInstanceUid: SER });
});

test("患者 ID と検査日だけでも指定できる", () => {
  const r = parseUrl("graphynext://open?patientId=P-001&studyDate=20260131");
  assert.deepStrictEqual(r, { ok: true, req: { patientId: "P-001", studyDate: "20260131" } });
});

test("患者 ID は URL エンコードを戻す（日本語・記号）", () => {
  const r = parseUrl(`graphynext://open?patientId=${encodeURIComponent("山田 太郎/01")}&studyDate=20260131`);
  assert.strictEqual(r.req.patientId, "山田 太郎/01");
});

test("未知のキーは無視する（ほかが正しければ通る）", () => {
  const r = parseUrl(`graphynext://open?studyInstanceUid=${UID}&evil=rm%20-rf&foo=bar`);
  assert.deepStrictEqual(r.req, { studyInstanceUid: UID });
});

test("スキームが違う引数は対象外（null）", () => {
  assert.strictEqual(parseUrl("https://example.com/?studyInstanceUid=1.2"), null);
  assert.strictEqual(parseUrl("C:\\Windows\\system32\\calc.exe"), null);
  assert.strictEqual(parseUrl("--inspect"), null);
  assert.strictEqual(parseUrl(undefined), null);
});

test("スキームの大文字小文字は区別しない", () => {
  assert.strictEqual(parseUrl(`GraphyNext://Open?studyInstanceUid=${UID}`).ok, true);
});

for (const [name, bad] of [
  ["文字種違反（英字）", "1.2.abc"],
  ["長すぎる（65 文字）", "1.".repeat(32) + "12"],
  ["ドットの連続", "1..2"],
  ["先頭のドット", ".1.2"],
  ["末尾のドット", "1.2."],
  ["パス区切りと ..", "../../etc/passwd"],
  ["セミコロン", "1.2;calc"],
  ["パイプ", "1.2|calc"],
  ["空白", "1.2 3"],
  ["空", ""],
]) {
  test(`負例: studyInstanceUid が ${name} なら開かない`, () => {
    const r = parseUrl(`graphynext://open?studyInstanceUid=${encodeURIComponent(bad)}`);
    assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} は通ってはいけない`);
    assert.ok(r.reason && r.reason.length > 0);
  });
}

test("負例: 必須のキーが無ければ開かない", () => {
  assert.strictEqual(parseUrl("graphynext://open").ok, false);
  assert.strictEqual(parseUrl("graphynext://open?seriesInstanceUid=1.2").ok, false);
});

test("負例: 未知のキーだけなら開かない", () => {
  assert.strictEqual(parseUrl("graphynext://open?foo=1&bar=2").ok, false);
});

test("負例: シリーズだけの指定は、検査 UID が無いので開かない", () => {
  assert.strictEqual(parseUrl(`graphynext://open?seriesInstanceUid=${SER}`).ok, false);
});

test("負例: 患者 ID だけで検査日が無ければ開かない（患者の全検査を黙って開かない）", () => {
  assert.strictEqual(parseUrl("graphynext://open?patientId=P-001").ok, false);
});

test("負例: 検査日が実在しない・形式違反", () => {
  for (const d of ["20261301", "20260230", "2026-01-31", "202601", "abcdefgh", ""]) {
    assert.strictEqual(parseUrl(`graphynext://open?patientId=P&studyDate=${d}`).ok, false, d);
  }
});

test("負例: 患者 ID の制御文字・長すぎ", () => {
  assert.strictEqual(parseUrl("graphynext://open?patientId=A%00B&studyDate=20260131").ok, false);
  assert.strictEqual(parseUrl("graphynext://open?patientId=A%0AB&studyDate=20260131").ok, false);
  assert.strictEqual(parseUrl(`graphynext://open?patientId=${"A".repeat(65)}&studyDate=20260131`).ok, false);
});

test("負例: 同じキーが複数あれば開かない（どれを使うかを曖昧にしない）", () => {
  assert.strictEqual(parseUrl(`graphynext://open?studyInstanceUid=${UID}&studyInstanceUid=${SER}`).ok, false);
});

test("負例: open 以外の操作・壊れた URL", () => {
  assert.strictEqual(parseUrl(`graphynext://delete?studyInstanceUid=${UID}`).ok, false);
  assert.strictEqual(parseUrl("graphynext://").ok, false);
});

test("コマンドライン: --open-study", () => {
  const r = parseArgv(["GRAPHY-Next.exe", "--open-study", UID]);
  assert.deepStrictEqual(r, { ok: true, req: { studyInstanceUid: UID } });
});

test("コマンドライン: = でつなぐ形が正（Chromium が空白区切りの値を末尾へ並べ替えても取り違えない）", () => {
  const reordered = ["electron", "--user-data-dir=/tmp/x", "--open-study", "--allow-file-access-from-files", "/app/dir", UID];
  assert.strictEqual(parseArgv(reordered).ok, false, "並べ替えられた空白区切りは、値を取り違えず、不正として何も開かない");
  assert.deepStrictEqual(parseArgv(["electron", "--user-data-dir=/tmp/x", `--open-study=${UID}`, "--allow-file-access-from-files", "/app/dir"]).req, { studyInstanceUid: UID });
});

test("コマンドライン: --open-study=<UID> と --open-series=<UID>", () => {
  const r = parseArgv(["app", `--open-study=${UID}`, `--open-series=${SER}`]);
  assert.deepStrictEqual(r.req, { studyInstanceUid: UID, seriesInstanceUid: SER });
});

test("コマンドライン: --open-study と --open-series", () => {
  const r = parseArgv(["app", "--open-study", UID, "--open-series", SER]);
  assert.deepStrictEqual(r.req, { studyInstanceUid: UID, seriesInstanceUid: SER });
});

test("コマンドライン: URL の引数でも同じ動き（Windows・Linux の second-instance）", () => {
  const r = parseArgv(["app", "--flag", `graphynext://open?studyInstanceUid=${UID}`]);
  assert.deepStrictEqual(r.req, { studyInstanceUid: UID });
});

test("コマンドライン: 該当が無ければ null（普通の起動）", () => {
  assert.strictEqual(parseArgv(["app", "--inspect"]), null);
  assert.strictEqual(parseArgv([]), null);
  assert.strictEqual(parseArgv(undefined), null);
});

test("負例: --open-study の値が無い・不正", () => {
  assert.strictEqual(parseArgv(["app", "--open-study"]).ok, false);
  assert.strictEqual(parseArgv(["app", "--open-study="]).ok, false);
  assert.strictEqual(parseArgv(["app", "--open-study=1.2;calc"]).ok, false);
  assert.strictEqual(parseArgv(["app", "--open-study=../x"]).ok, false);
  assert.strictEqual(parseArgv(["app", "--open-study", "../x"]).ok, false);
  assert.strictEqual(parseArgv(["app", "--open-study", "1.2;calc"]).ok, false);
});

test("validate は、許可していない形（数値など）も弾く", () => {
  assert.strictEqual(validate({ studyInstanceUid: 123 }).ok, false);
  assert.strictEqual(validate({}).ok, false);
});

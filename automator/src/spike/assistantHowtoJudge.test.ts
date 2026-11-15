// 実行: cd automator && npx tsx --test src/spike/assistantHowtoJudge.test.ts
import test from "node:test";
import assert from "node:assert";
import { HOWTO_CASES, hasRawToolCall, judgeHowto, notJapanese } from "./assistantHowtoJudge.js";

const c = (id: string) => HOWTO_CASES.find((x) => x.id === id)!;

test("正例: 順に手順を並べた回答は通る", () => {
  const ok = "1. 左の **患者名** に「テスト花子」と入れて **検索** を押します。2. 一覧で検査を選び、CT の **シリーズ** を選びます。3. ツールバーの **2D Viewer** を押します。";
  assert.deepEqual(judgeHowto(c("h-open-ct-today"), ok, true), { verdict: "pass", reasons: [] });
});

test("負例: 必須の語が 1 つ欠けると落ちる", () => {
  const r = judgeHowto(c("h-open-ct-today"), "患者名を入れて検索し、シリーズを選びます。", false);
  assert.equal(r.verdict, "fail");
  assert.ok(r.reasons.some((x) => x.includes("2D Viewer")));
});

test("負例: 順序が逆（開く→探す）だと落ちる", () => {
  const r = judgeHowto(c("h-open-ct-today"), "2D Viewer を押します。その前に、患者名を入れて検索し、シリーズを選びます。", false);
  assert.equal(r.verdict, "fail");
  assert.ok(r.reasons.some((x) => x.startsWith("順序")));
});

test("負例: 文書に無い語（存在しないボタン）が出ると落ちる", () => {
  const r = judgeHowto(c("a-report-print"), "ありません。ただし印刷ボタンを押してください。", false);
  assert.equal(r.verdict, "fail");
  assert.ok(r.reasons.some((x) => x.includes("印刷ボタン")));
});

test("文書に無い質問: 「無い」と言い手順カードも作らなければ通る", () => {
  assert.equal(judgeHowto(c("a-registry"), "提供された文書にはその方法は載っていません。", false).verdict, "pass");
});

test("負例: 文書に無いのに手順カードを作る／「無い」と言わないと落ちる", () => {
  assert.equal(judgeHowto(c("a-registry"), "載っていません。", true).verdict, "fail");
  assert.equal(judgeHowto(c("a-registry"), "1. 設定を開きます。2. 自動起動をオンにします。", false).verdict, "fail");
});

test("全角・半角の違い（NFKC）を吸収する", () => {
  assert.equal(judgeHowto(c("h-open-3d"), "シリーズを選んでから、３D Viewer を押します。", false).verdict, "pass");
});

test("質問集合: 必須語は重複せず、各 case に根拠の docs がある", () => {
  const ids = new Set(HOWTO_CASES.map((x) => x.id));
  assert.equal(ids.size, HOWTO_CASES.length);
  assert.ok(HOWTO_CASES.every((x) => x.doc.length > 0));
  assert.ok(HOWTO_CASES.filter((x) => x.kind === "steps").every((x) => (x.must?.length ?? 0) > 0));
});

test("言語: 英語だけの回答は、文書に無い旨を言っていても失敗（日本語の UI）", () => {
  const absent = HOWTO_CASES.find((c) => c.kind === "absent")!;
  const en = judgeHowto(absent, "Documentation does not cover this.", false);
  assert.equal(en.verdict, "fail");
  assert.ok(en.reasons.some((r) => r.startsWith("言語")));
  assert.equal(judgeHowto(absent, "このドキュメントには載っていません。", false).verdict, "pass");
});

test("本文に JSON のまま出た道具呼び出しを検出する（正例と負例）", () => {
  assert.equal(hasRawToolCall('手順です。 propose_steps { "title": "x", "steps": [] }'), true);
  assert.equal(hasRawToolCall("propose_steps を使います"), false);
  assert.equal(notJapanese("OK"), true);
  assert.equal(notJapanese("検索を押します"), false);
});

test("順序: 導入の言い換えで語が先に出ても、手順が正しい順なら合格。順序が逆なら失敗（正例と負例）", () => {
  const c = HOWTO_CASES.find((x) => x.id === "h-open-ct-today")!;
  const good = "2D Viewer で開く手順です。左の検索パネルの 患者名 に入れ、検索 を押し、シリーズの行を選び、ツールバーの 2D Viewer を押します。";
  assert.equal(judgeHowto(c, good, true).verdict, "pass");
  const reversed = "2D Viewer を押し、シリーズを選び、検索 を押し、患者名 を入れます。";
  const r = judgeHowto(c, reversed, true);
  assert.equal(r.verdict, "fail");
  assert.ok(r.reasons.some((x) => x.startsWith("順序")));
});

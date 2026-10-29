import { describe, expect, it } from "vitest";
import { rateTexts } from "../EvalSection";

const t = (k: string, v?: Record<string, string | number>) => `${k}|${JSON.stringify(v ?? {})}`;
const q = (passes: number, n: number) => ({ pass: passes === n, passes, n });

describe("rateTexts（質問単位）", () => {
  it("正例: 質問単位の件数と Wilson 区間（9/10 → 90%、60–98%）。質問が 20 未満なので参考値", () => {
    const cases = [...Array(9).fill(0).map(() => q(5, 5)), q(4, 5)];
    const r = rateTexts(cases, t)!;
    expect(r.head).toBe(`assistant.eval.rateRef|${JSON.stringify({ ok: 9, q: 10, pct: 90, lo: 60, hi: 98 })}`);
  });
  it("質問が 20 以上なら参考値にしない", () => {
    const cases = Array(20).fill(0).map(() => q(1, 1));
    expect(rateTexts(cases, t)!.head.startsWith("assistant.eval.rate|")).toBe(true);
  });
  it("反復が全く揺れない（0/5 か 5/5 だけ）ときは、反復が情報を足していないと出す。区間は反復の合計に付けない", () => {
    const r = rateTexts([q(5, 5), q(0, 5), q(5, 5)], t)!;
    expect(r.reps).toBe(`assistant.eval.repsSame|${JSON.stringify({ passes: 10, n: 15, flaky: 0 })}`);
    expect(r.head).toContain('"ok":2,"q":3');
  });
  it("負例: 揺れた質問（0<passes<n）を数える", () => {
    const r = rateTexts([q(4, 5), q(5, 5), q(2, 5), q(0, 5)], t)!;
    expect(r.reps).toBe(`assistant.eval.repsFlaky|${JSON.stringify({ passes: 11, n: 20, flaky: 2 })}`);
  });
  it("反復 1 回（n === 質問数）は反復の行を出さない。質問 0 件は null（未取得）", () => {
    expect(rateTexts([q(1, 1), q(0, 1)], t)!.reps).toBeNull();
    expect(rateTexts([], t)).toBeNull();
  });
});

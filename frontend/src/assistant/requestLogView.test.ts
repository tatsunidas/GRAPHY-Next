import { describe, expect, it } from "vitest";
import { isLatencyReference, MAX_RECENT, modelRows, secondsText, recentRows, shortText, tokenText, totalIsPartial } from "./requestLogView";

describe("tokenText", () => {
  it("null は不明、実際の 0 は 0（0 で埋めない）", () => {
    expect(tokenText(null, "不明")).toBe("不明");
    expect(tokenText(0, "不明")).toBe("0");
    expect(tokenText(321, "不明")).toBe("321");
  });
});

describe("recentRows", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    ts: "2026-10-26T07:00:00.000Z", modelId: "m", modelVersion: "m-2026", destination: "local", outcome: "ok",
    usage: { in: 77, out: 11 }, toolCalls: ["fit"], latencyMs: 120, ...over,
  });
  it("正例: 項目が揃う（版があれば版を出す）", () => {
    expect(recentRows([row()])[0]).toMatchObject({ model: "m-2026", destination: "local", outcome: "ok", tokensIn: 77, tokensOut: 11, tools: ["fit"], latencyMs: 120 });
  });
  it("usage が null・欠け・片方不明は不明のまま（0 にしない）", () => {
    const rs = recentRows([row({ usage: null }), row({ usage: undefined }), row({ usage: { in: 5, out: null } }), row({ usage: { in: -1, out: "3" } })]);
    expect(rs.map((r) => [r.tokensIn, r.tokensOut])).toEqual([[null, null], [null, null], [5, null], [null, null]]);
  });
  it("直近 10 件までに切る。配列でなければ空", () => {
    expect(recentRows(Array.from({ length: 25 }, () => row()))).toHaveLength(MAX_RECENT);
    expect(recentRows(undefined)).toEqual([]);
    expect(recentRows("x")).toEqual([]);
  });
  it("形が崩れた行（null・文字列・型違い）でも落ちず、長い文字列は切る", () => {
    const rs = recentRows([null, "x", 5, { modelId: "x".repeat(500), outcome: "o".repeat(500), toolCalls: [1, "a".repeat(100), null], latencyMs: "9", destination: 7 }]);
    expect(rs).toHaveLength(4);
    expect(rs[3].model.length).toBeLessThanOrEqual(60);
    expect(rs[3].outcome.length).toBeLessThanOrEqual(40);
    expect(rs[3].tools).toEqual(["a".repeat(40)]);
    expect(rs[3].latencyMs).toBeNull();
    expect(rs[3].destination).toBe("external");
  });
});

describe("modelRows / totalIsPartial", () => {
  it("要求数が 0・数でない行は出さない。数でないトークンは 0（合計の素）だが不明件数が別に出る", () => {
    const rows = modelRows([
      { provider: "p", model: "m", requests: 2, tokensIn: 10, tokensOut: 2, unknownUsage: 1 },
      { provider: "p", model: "z", requests: 0, tokensIn: 0, tokensOut: 0, unknownUsage: 0 },
      { provider: "p", model: "y", requests: "3" },
      null,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "m", requests: 2, tokensIn: 10, unknownUsage: 1 });
    expect(modelRows(undefined)).toEqual([]);
  });
  it("不明が 1 件でもあれば合計は取れた分（注記を付ける）", () => {
    expect(totalIsPartial([{ provider: "p", model: "m", requests: 2, tokensIn: 1, tokensOut: 1, unknownUsage: 1, latency: null }])).toBe(true);
    expect(totalIsPartial([{ provider: "p", model: "m", requests: 2, tokensIn: 1, tokensOut: 1, unknownUsage: 0, latency: null }])).toBe(false);
    expect(totalIsPartial([])).toBe(false);
  });
  it("shortText: 文字だけ・長さで切る", () => {
    expect(shortText(5)).toBe("");
    expect(shortText("a".repeat(100), 10)).toBe("a".repeat(10));
  });
});

describe("応答時間の表示", () => {
  it("modelRows: 形が正しい latency だけ通す。壊れた値・0 件は null（0 にしない）", () => {
    const m = (latency: unknown) => modelRows([{ provider: "p", model: "m", requests: 1, latency }])[0].latency;
    expect(m({ n: 12, p50: 2100, p95: 6800 })).toEqual({ n: 12, p50: 2100, p95: 6800 });
    expect(m({ n: 0, p50: 0, p95: 0 })).toBeNull();
    expect(m({ n: 3, p50: "1", p95: 2 })).toBeNull();
    expect(m({ n: 3, p50: -1, p95: 2 })).toBeNull();
    expect(m(null)).toBeNull();
    expect(m(undefined)).toBeNull();
  });
  it("参考値の境界は n=19 と 20", () => {
    expect(isLatencyReference(19)).toBe(true);
    expect(isLatencyReference(20)).toBe(false);
  });
  it("秒の表示", () => {
    expect(secondsText(2100)).toBe("2.1 s");
    expect(secondsText(0)).toBe("0.0 s");
  });
});

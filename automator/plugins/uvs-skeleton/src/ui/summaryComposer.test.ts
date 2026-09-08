/**
 * フロント側の合成規則を、**Java と共有するテストベクタ**で縛る。
 *
 * 🔴 `cases`（7 件）だけ通して満足しない。しきい値ハンドルのドラッグが実際に触るのは
 * **補間（`interpolationCases`）とクランプ（`thresholdCases`）**であり、そこが後半 2 群である。
 *
 * 正本は Java の `SummaryComposer` / `Indices`。実機では `op:"compose"` と突き合わせる
 * （`automator/src/spike/uvsPluginCheck.ts` の段 6-4 / 6-6）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { asFrame1, format, interpolate, parse, type Frame1 } from "./indices";
import { applyPredictionThreshold, compose, removalsFromScan, results } from "./summaryComposer";

interface Vectors {
  cases: {
    name: string;
    frameCount: number;
    colorRemove: number[];
    staticRemove: number[];
    heart: number[] | null;
    userAdd: number[];
    userRemove: number[];
    expected: { heart: number[]; removedByPrediction: number[]; finalIndices: number[] };
  }[];
  interpolationCases: {
    name: string;
    known: number[];
    size: number;
    interval: number;
    expectedAt: Record<string, number>;
  }[];
  thresholdCases: {
    name: string;
    predScores: Record<string, number>;
    frameCount: number;
    interval: number;
    threshold: number;
    expectedHeartContains: number[];
    expectedHeartExcludes: number[];
  }[];
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../testdata/summary-composer-cases.json", import.meta.url)), "utf8"),
) as Vectors;

const f1 = (xs: number[]): Frame1[] => xs.map(asFrame1);

describe("compose — 共有ベクタ（合成規則）", () => {
  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const d = compose({
      frameCount: c.frameCount,
      colorRemove: f1(c.colorRemove),
      staticRemove: f1(c.staticRemove),
      heart: c.heart === null ? null : f1(c.heart),
      userAdd: f1(c.userAdd),
      userRemove: f1(c.userRemove),
    });
    expect(d.heart).toEqual(c.expected.heart);
    expect(d.removedByPrediction).toEqual(c.expected.removedByPrediction);
    expect(d.finalIndices).toEqual(c.expected.finalIndices);
  });

  it("ベクタは 7 件ある（減っていたら取りこぼしを疑う）", () => {
    expect(vectors.cases.length).toBe(7);
  });
});

describe("interpolate — 共有ベクタ（補間）", () => {
  it.each(vectors.interpolationCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const got = interpolate(c.known, c.size, c.interval);
    for (const [at, want] of Object.entries(c.expectedAt)) {
      expect(got[Number(at)]).toBeCloseTo(want, 12);
    }
  });
});

describe("applyPredictionThreshold — 共有ベクタ（補間＋クランプ）", () => {
  it.each(vectors.thresholdCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    // 🔑 predScores は**サンプル順の密配列**に直して渡す（Java 側も並び順しか見ない）。
    const known = Object.keys(c.predScores)
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => c.predScores[String(k)]);
    const got = applyPredictionThreshold(known, c.frameCount, c.interval, c.threshold);
    expect(got).not.toBeNull();
    for (const i of c.expectedHeartContains) expect(got!.heart).toContain(i);
    for (const i of c.expectedHeartExcludes) expect(got!.heart).not.toContain(i);
  });

  it("スコアが空なら null（＝予測未実行として扱わせる）", () => {
    expect(applyPredictionThreshold([], 10, 5, 0.5)).toBeNull();
  });
});

describe("results — 除外の内訳", () => {
  it("🔴 色・静止・確率は重なるので足し合わせても総数にならない", () => {
    const d = compose({
      frameCount: 10,
      colorRemove: f1([2, 3]),
      staticRemove: f1([3, 4]),
      heart: f1([1, 2, 3, 4, 5]),
    });
    const r = results(10, d);
    expect(r.totalRemoved).toBe(8);
    expect(r.colorRemoved + r.staticRemoved + r.probaRemoved).not.toBe(r.totalRemoved);
  });

  it("ユーザ追加分は各内訳から差し引く（Swing と同じ）", () => {
    const d = compose({
      frameCount: 10,
      colorRemove: f1([2, 3]),
      staticRemove: [],
      heart: f1([1, 2, 3, 4, 5]),
      userAdd: f1([3]),
    });
    const r = results(10, d, f1([3]));
    expect(r.colorRemoved).toBe(1); // 3 は利用者が戻したので数えない
    expect(r.userAdded).toBe(1);
  });
});

describe("removalsFromScan — 0-based の走査結果を 1-based の除外へ", () => {
  it("🔴 区間の先頭ぶんを足して 1-based にする（ここ以外で +1 を書かない）", () => {
    // from=10、cpr[0] は原本の 10 番目（0-based）＝ 11（1-based）。
    const { colorRemove, staticRemove } = removalsFromScan(10, [0.9, 0.0], [1.0, 0.01], 0.0035, 0.19);
    expect(colorRemove).toEqual([11]);
    expect(staticRemove).toEqual([12]);
  });

  it("静止は「小さいほう」で拾う（向きを取り違えると全部静止になる）", () => {
    const { staticRemove } = removalsFromScan(0, [0, 0, 0], [0.5, 0.1, 0.3], 0.0035, 0.19);
    expect(staticRemove).toEqual([2]);
  });
});

describe("parse / format — 手動入力の往復", () => {
  it('"1,5-8,12" を展開して畳み直すと元に戻る', () => {
    const parsed = parse("1,5-8,12");
    expect(parsed).toEqual([1, 5, 6, 7, 8, 12]);
    expect(format(parsed)).toBe("1,5-8,12");
  });

  it("壊れた入力は捨てる（例外にしない＝入力欄で手が止まらない）", () => {
    expect(parse("abc")).toEqual([]);
    expect(parse("8-5")).toEqual([]); // 逆順の区間
    expect(parse("")).toEqual([]);
    expect(parse(null)).toEqual([]);
  });

  it("重複と順不同を畳む", () => {
    expect(format(parse("5,3,3,4"))).toBe("3-5");
  });
});

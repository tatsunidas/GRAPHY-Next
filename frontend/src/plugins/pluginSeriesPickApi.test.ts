import { afterEach, describe, expect, it } from "vitest";
import { peekSeriesPick, pickSeries, resetSeriesPickForTest, settleSeriesPick } from "./pluginSeriesPickApi";

afterEach(() => resetSeriesPickForTest());

describe("pickSeries のストア", () => {
  it("開く → 決定で、選んだ UID が Promise に返る", async () => {
    const p = pickSeries({ title: "CT を選ぶ", modalities: ["ct"] });
    expect(peekSeriesPick()).toMatchObject({ title: "CT を選ぶ", modalities: ["CT"], multiple: true });
    settleSeriesPick([{ studyUid: "1.2", seriesUid: "1.2.3" }]);
    expect(await p).toEqual([{ studyUid: "1.2", seriesUid: "1.2.3" }]);
    expect(peekSeriesPick()).toBeNull();
  });

  it("取り消しは空配列（例外にしない）", async () => {
    const p = pickSeries();
    settleSeriesPick([]);
    expect(await p).toEqual([]);
  });

  it("🔴 同時に出すのは 1 つ。2 件目は待ち、1 件目が終わると順番に開く（取り違えない）", async () => {
    const a = pickSeries({ title: "A" });
    const b = pickSeries({ title: "B" });
    expect(peekSeriesPick()?.title).toBe("A");
    settleSeriesPick([{ studyUid: "A", seriesUid: "a" }]);
    expect(peekSeriesPick()?.title).toBe("B");
    settleSeriesPick([{ studyUid: "B", seriesUid: "b" }]);
    expect(await a).toEqual([{ studyUid: "A", seriesUid: "a" }]);
    expect(await b).toEqual([{ studyUid: "B", seriesUid: "b" }]);
    expect(peekSeriesPick()).toBeNull();
  });

  it("待っている呼び出しも、リセットで取り消し（空配列）として終わる", async () => {
    const a = pickSeries();
    const b = pickSeries();
    resetSeriesPickForTest();
    expect(await a).toEqual([]);
    expect(await b).toEqual([]);
  });
});

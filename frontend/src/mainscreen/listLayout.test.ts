/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { LIST_LAYOUTS, isPaneLayout, isTreeOpen, parseListLayout, pickFirstImageSeries } from "./listLayout";

describe("parseListLayout", () => {
  it("4 つの形式をそのまま読む", () => {
    for (const l of LIST_LAYOUTS) expect(parseListLayout(l)).toBe(l);
    expect(LIST_LAYOUTS).toEqual(["table", "split", "side", "tree"]);
  });
  it("未保存・壊れた値・未知の値は従来の表示", () => {
    for (const v of [null, undefined, "", "grid", "SPLIT", "Tree", "{\"a\":1}", "undefined"]) {
      expect(parseListLayout(v)).toBe("table");
    }
  });
});

describe("isPaneLayout", () => {
  it("上下・左右だけがペインに描く", () => {
    expect(LIST_LAYOUTS.filter(isPaneLayout)).toEqual(["split", "side"]);
  });
});

describe("isTreeOpen", () => {
  const page = ["a", "b"];
  it("ツリーで、選んだ検査が今のページにあるときだけ開く", () => {
    expect(isTreeOpen("tree", "b", page)).toBe(true);
  });
  it("他の形式・未選択・別ページの検査では開かない", () => {
    for (const l of LIST_LAYOUTS.filter((x) => x !== "tree")) expect(isTreeOpen(l, "b", page)).toBe(false);
    expect(isTreeOpen("tree", null, page)).toBe(false);
    expect(isTreeOpen("tree", "z", page)).toBe(false);
  });
});

describe("pickFirstImageSeries", () => {
  const s = (uid: string, modality: string | null) => ({ uid, modality });
  it("先頭が画像でなければ、次の画像シリーズを選ぶ", () => {
    expect(pickFirstImageSeries([s("a", "SR"), s("b", "PR"), s("c", "CT"), s("d", "MR")])?.uid).toBe("c");
  });
  it("先頭が画像ならそれ（小文字の modality も同じ扱い）", () => {
    expect(pickFirstImageSeries([s("a", "ct"), s("b", "SR")])?.uid).toBe("a");
    expect(pickFirstImageSeries([s("a", "sr"), s("b", "MR")])?.uid).toBe("b");
  });
  it("画像が無い・空・modality 不明は、modality 不明を画像として扱い、全部が非画像なら null", () => {
    expect(pickFirstImageSeries([s("a", "SR"), s("b", "KO"), s("c", "RTSTRUCT")])).toBeNull();
    expect(pickFirstImageSeries([])).toBeNull();
    expect(pickFirstImageSeries([s("a", null)])?.uid).toBe("a");
  });
});

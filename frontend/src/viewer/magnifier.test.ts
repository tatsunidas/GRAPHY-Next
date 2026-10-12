/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { installTrueMagnification, magnifySizeFor } from "./magnifier";

describe("magnifySizeFor", () => {
  it("ビューポートの高さとレンズの高さから、指定の倍率になる値を返す", () => {
    expect(magnifySizeFor(4, 1000, 250)).toBe(16);
    expect(magnifySizeFor(4, 250, 250)).toBe(4);
  });

  it("高さが読めないときは倍率をそのまま返す", () => {
    expect(magnifySizeFor(4, 0, 250)).toBe(4);
  });
});

describe("installTrueMagnification", () => {
  it("押した要素の高さで magnifySize を合わせてから元の処理を呼ぶ", () => {
    const calls: number[] = [];
    const tool = {
      configuration: { magnifySize: 10, magnifyHeight: 250 },
      preMouseDownCallback(this: void) { calls.push(tool.configuration.magnifySize); return true; },
    };
    installTrueMagnification(tool, 4);
    installTrueMagnification(tool, 4); // 二重に包まない
    expect(tool.preMouseDownCallback({ detail: { element: { clientHeight: 1000 } } })).toBe(true);
    expect(calls).toEqual([16]);
  });
});

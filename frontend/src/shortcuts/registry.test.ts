/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { displayShortcut, matchesShortcut, SHORTCUTS } from "./registry";

/**
 * vitest の環境は "node" なので本物の KeyboardEvent は作れない。
 * 判定が読むフィールドだけを持つ最小の偽イベントを渡す（実装の依存先を固定する意味もある）。
 */
function key(init: { key?: string; code?: string; shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean }): KeyboardEvent {
  return {
    key: init.key ?? "",
    code: init.code ?? "",
    shiftKey: init.shift ?? false,
    ctrlKey: init.ctrl ?? false,
    altKey: init.alt ?? false,
    metaKey: init.meta ?? false,
  } as KeyboardEvent;
}

describe("matchesShortcut — スライス送り", () => {
  it("矢印キーで一致する（NumLock を切ったテンキーもここに来る）", () => {
    expect(matchesShortcut("nav-prev-slice", key({ key: "ArrowUp", code: "Numpad8" }))).toBe(true);
    expect(matchesShortcut("nav-next-slice", key({ key: "ArrowDown", code: "Numpad2" }))).toBe(true);
  });

  it("🔴 NumLock ON のテンキー（key は数字）でも物理キーで一致する", () => {
    // これが無いと、NumLock の状態でテンキーが効いたり効かなかったりする。
    expect(matchesShortcut("nav-prev-slice", key({ key: "8", code: "Numpad8" }))).toBe(true);
    expect(matchesShortcut("nav-next-slice", key({ key: "2", code: "Numpad2" }))).toBe(true);
  });

  it("上下を取り違えない", () => {
    expect(matchesShortcut("nav-prev-slice", key({ key: "2", code: "Numpad2" }))).toBe(false);
    expect(matchesShortcut("nav-next-slice", key({ key: "8", code: "Numpad8" }))).toBe(false);
  });

  it("最上段の数字キー（テンキーでない 8）は送らない", () => {
    expect(matchesShortcut("nav-prev-slice", key({ key: "8", code: "Digit8" }))).toBe(false);
  });

  it("修飾キーが付いた物理キーは受けない（他の割り当てと衝突させない）", () => {
    expect(matchesShortcut("nav-prev-slice", key({ key: "8", code: "Numpad8", ctrl: true }))).toBe(false);
    expect(matchesShortcut("nav-prev-slice", key({ key: "8", code: "Numpad8", shift: true }))).toBe(false);
    expect(matchesShortcut("nav-prev-slice", key({ key: "8", code: "Numpad8", alt: true }))).toBe(false);
  });

  it("未知の id は常に false", () => {
    expect(matchesShortcut("no-such-shortcut", key({ key: "ArrowUp" }))).toBe(false);
  });
});

describe("displayShortcut", () => {
  it("別キーがあれば併記する", () => {
    const prev = SHORTCUTS.find((s) => s.id === "nav-prev-slice")!;
    expect(displayShortcut(prev)).toBe("↑ / Num 8");
  });

  it("別キーが無ければ主キーだけ", () => {
    const home = SHORTCUTS.find((s) => s.id === "nav-first")!;
    expect(displayShortcut(home)).toBe("Home");
  });
});

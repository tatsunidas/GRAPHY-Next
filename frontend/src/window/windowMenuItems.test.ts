import { describe, expect, it } from "vitest";
import { windowMenuItems, type WindowState } from "./windowMenuItems";

const t = (k: string) => k;
const NORMAL: WindowState = { maximized: false, fullscreen: false, minimized: false };
const flags = (s: WindowState) => Object.fromEntries(windowMenuItems(t, s, () => {}, "Linux x86_64").map((i) => [i.testId.replace("menu-item-window-", ""), i.disabled]));

describe("windowMenuItems", () => {
  it("通常の大きさ: フルスクリーン・最大化・最小化は押せて、元に戻すだけ無効", () => {
    expect(flags(NORMAL)).toEqual({ fullscreen: false, maximize: false, minimize: false, restore: true });
  });
  it("最大化中: 最大化と、元に戻す…の組が入れ替わる", () => {
    expect(flags({ ...NORMAL, maximized: true })).toEqual({ fullscreen: false, maximize: true, minimize: false, restore: false });
  });
  it("フルスクリーン中: フルスクリーンが無効・最大化と元に戻すは有効", () => {
    expect(flags({ ...NORMAL, fullscreen: true })).toEqual({ fullscreen: true, maximize: false, minimize: false, restore: false });
  });
  it("最大化してからフルスクリーン: 元に戻すが押せる", () => {
    expect(flags({ maximized: true, fullscreen: true, minimized: false }).restore).toBe(false);
  });
  it("各項目が対応する action を呼ぶ", () => {
    const calls: string[] = [];
    for (const it of windowMenuItems(t, NORMAL, (a) => calls.push(a), "Win32")) it.onClick();
    expect(calls).toEqual(["fullscreen", "maximize", "minimize", "restore"]);
  });
  it("キーの表記: Win/Linux は F11、macOS は ⌃⌘F", () => {
    expect(windowMenuItems(t, NORMAL, () => {}, "Win32")[0].label).toContain("(F11)");
    expect(windowMenuItems(t, NORMAL, () => {}, "MacIntel")[0].label).toContain("(⌃⌘F)");
  });
});

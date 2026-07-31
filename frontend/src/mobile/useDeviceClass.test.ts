/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import {
  autoUiMode,
  classifyDevice,
  normalizeOverride,
  resolveUiMode,
  type DeviceSignals,
} from "./useDeviceClass";

/** 代表的な端末のシグナル。 */
const PHONE: DeviceSignals = { phoneWidth: true, tabletWidth: true, coarsePointer: true };
const TABLET: DeviceSignals = { phoneWidth: false, tabletWidth: true, coarsePointer: true };
/** 1024px 以下に縮めたデスクトップブラウザ（マウス）。 */
const NARROW_DESKTOP: DeviceSignals = { phoneWidth: false, tabletWidth: true, coarsePointer: false };
const DESKTOP: DeviceSignals = { phoneWidth: false, tabletWidth: false, coarsePointer: false };
/** タッチ対応のノート PC（広い画面 ＋ 粗いポインタ）。 */
const TOUCH_LAPTOP: DeviceSignals = { phoneWidth: false, tabletWidth: false, coarsePointer: true };

describe("classifyDevice", () => {
  it("幅で phone / tablet / desktop を分ける", () => {
    expect(classifyDevice(PHONE)).toBe("phone");
    expect(classifyDevice(TABLET)).toBe("tablet");
    expect(classifyDevice(DESKTOP)).toBe("desktop");
  });

  it("ポインタ精度は端末クラスには影響しない（幅だけで決める）", () => {
    expect(classifyDevice(TOUCH_LAPTOP)).toBe("desktop");
    expect(classifyDevice(NARROW_DESKTOP)).toBe("tablet");
  });
});

describe("autoUiMode", () => {
  it("phone は常にモバイル", () => {
    expect(autoUiMode(PHONE)).toBe("mobile");
    expect(autoUiMode({ ...PHONE, coarsePointer: false })).toBe("mobile");
  });

  it("tablet はポインタが粗いときだけモバイル", () => {
    expect(autoUiMode(TABLET)).toBe("mobile");
    // 縮めただけのデスクトップブラウザを巻き込まない。
    expect(autoUiMode(NARROW_DESKTOP)).toBe("desktop");
  });

  it("広い画面はタッチ対応でもデスクトップ（タッチ対応ノート PC を巻き込まない）", () => {
    expect(autoUiMode(TOUCH_LAPTOP)).toBe("desktop");
    expect(autoUiMode(DESKTOP)).toBe("desktop");
  });
});

describe("resolveUiMode", () => {
  it("auto は自動判定に従う", () => {
    expect(resolveUiMode(PHONE, "auto")).toBe("mobile");
    expect(resolveUiMode(DESKTOP, "auto")).toBe("desktop");
  });

  it("明示選択は自動判定を上書きする（両方向）", () => {
    // スマホでもデスクトップ UI を見たい / タブレットで通常 UI を使いたいケース。
    expect(resolveUiMode(PHONE, "desktop")).toBe("desktop");
    // 逆に、デスクトップからモバイル UI を確認したいケース。
    expect(resolveUiMode(DESKTOP, "mobile")).toBe("mobile");
  });
});

describe("normalizeOverride", () => {
  it("既知の値だけ通す", () => {
    expect(normalizeOverride("mobile")).toBe("mobile");
    expect(normalizeOverride("desktop")).toBe("desktop");
  });

  it("未設定・壊れた値は auto に倒す", () => {
    expect(normalizeOverride(null)).toBe("auto");
    expect(normalizeOverride(undefined)).toBe("auto");
    expect(normalizeOverride("")).toBe("auto");
    expect(normalizeOverride("auto")).toBe("auto");
    expect(normalizeOverride("Mobile")).toBe("auto");
    expect(normalizeOverride("{}")).toBe("auto");
  });
});

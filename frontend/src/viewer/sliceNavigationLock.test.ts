/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * スライス送りの錠。守りたいのは **「掛けたら必ず外れる」** ことだけ。
 *
 * <p>外れ残ると**フレームが二度と送れないビューア**になり、原因が
 * 「前に開いた解析ダイアログ」なので利用者からは絶対に辿れない。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  isSliceNavigationLocked,
  lockSliceNavigation,
  resetSliceNavigationLock,
} from "./sliceNavigationLock";

afterEach(() => resetSliceNavigationLock());

describe("sliceNavigationLock", () => {
  it("既定は掛かっていない", () => {
    expect(isSliceNavigationLocked()).toBe(false);
  });

  it("掛けて外せる", () => {
    const release = lockSliceNavigation();
    expect(isSliceNavigationLocked()).toBe(true);
    release();
    expect(isSliceNavigationLocked()).toBe(false);
  });

  it("入れ子でも、全部外れるまで解けない（ダイアログが重なることがある）", () => {
    const a = lockSliceNavigation();
    const b = lockSliceNavigation();
    a();
    expect(isSliceNavigationLocked()).toBe(true);
    b();
    expect(isSliceNavigationLocked()).toBe(false);
  });

  it("🔴 二重解除で他人の錠を外さない（React の StrictMode / 再マウントで起きうる）", () => {
    const a = lockSliceNavigation();
    const b = lockSliceNavigation();
    a();
    a();
    a();
    expect(isSliceNavigationLocked()).toBe(true);
    b();
    expect(isSliceNavigationLocked()).toBe(false);
  });

  it("カウントは負に落ちない", () => {
    const a = lockSliceNavigation();
    a();
    a();
    const b = lockSliceNavigation();
    expect(isSliceNavigationLocked()).toBe(true);
    b();
    expect(isSliceNavigationLocked()).toBe(false);
  });
});

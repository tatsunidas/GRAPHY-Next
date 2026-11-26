/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it, vi } from "vitest";
import { backdropClose } from "./backdropClose";

const bg = {} as HTMLElement;
const child = {} as HTMLElement;
const ev = (target: HTMLElement) => ({ target, currentTarget: bg }) as never;

describe("backdropClose", () => {
  it("★ 背景で押して背景で離す（普通のクリック）→ 閉じる", () => {
    const close = vi.fn();
    const h = backdropClose(close);
    h.onMouseDown(ev(bg));
    h.onClick(ev(bg));
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("★ 負例: 入力欄（子）で押して、外（背景）で離す → click は背景に届くが、閉じない", () => {
    const close = vi.fn();
    const h = backdropClose(close);
    h.onMouseDown(ev(child));
    h.onClick(ev(bg));
    expect(close).not.toHaveBeenCalled();
  });
  it("子の中のクリックは閉じない（ダイアログ内のボタンなど）", () => {
    const close = vi.fn();
    const h = backdropClose(close);
    h.onMouseDown(ev(child));
    h.onClick(ev(child));
    expect(close).not.toHaveBeenCalled();
  });
  it("負例の後の次のクリックは、普通に閉じる（状態を引きずらない）", () => {
    const close = vi.fn();
    const h = backdropClose(close);
    h.onMouseDown(ev(child));
    h.onClick(ev(bg));
    h.onMouseDown(ev(bg));
    h.onClick(ev(bg));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

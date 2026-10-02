/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it, vi } from "vitest";
import { getXa3dPluginItems, publishXa3dPluginItems } from "./xa3dPluginItems";

describe("H63 3D QCA ダイアログのプラグイン項目", () => {
  it("id と表示名が同じなら配列を差し替えない（ダイアログを無駄に描き直さない）", () => {
    publishXa3dPluginItems([{ id: "a", label: "A", onClick: () => {} }]);
    const first = getXa3dPluginItems();
    publishXa3dPluginItems([{ id: "a", label: "A", onClick: () => {} }]);
    expect(getXa3dPluginItems()).toBe(first);
  });

  it("🔴 クリックは最後に置かれた onClick へ委譲する（古い actions を掴まない）", () => {
    const old = vi.fn();
    const fresh = vi.fn();
    publishXa3dPluginItems([{ id: "q", label: "Q", onClick: old }]);
    const item = getXa3dPluginItems()[0];
    publishXa3dPluginItems([{ id: "q", label: "Q", onClick: fresh }]);
    item.onClick();
    expect(old).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledOnce();
  });

  it("項目が増減すれば差し替える", () => {
    publishXa3dPluginItems([{ id: "a", label: "A", onClick: () => {} }]);
    const first = getXa3dPluginItems();
    publishXa3dPluginItems([]);
    expect(getXa3dPluginItems()).not.toBe(first);
    expect(getXa3dPluginItems()).toEqual([]);
  });
});

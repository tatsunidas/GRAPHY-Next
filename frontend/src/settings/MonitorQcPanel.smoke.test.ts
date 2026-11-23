// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// モニター診断パネルの DOM の煙テスト: 実際に描画し、配置の略図と表（並び・向き・画素数・MP）を通す。
// main（desktop/main.js の graphy:list-displays）は偽物で渡す。形は desktopBridge.ts の DisplayInfo に合わせる。
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DisplayInfo } from "../desktopBridge";
import { I18nProvider } from "../i18n/i18n";
import { MonitorQcPanel } from "./MonitorQcPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const win = window as unknown as { graphyDesktop?: unknown };

function disp(id: number, x: number, y: number, w: number, h: number, scaleFactor = 1, extra: Partial<DisplayInfo> = {}): DisplayInfo {
  return {
    id, label: `Mon ${id}`, primary: id === 1, internal: false,
    bounds: { x, y, width: w, height: h }, workArea: { x, y, width: w, height: h }, size: { width: w, height: h },
    scaleFactor, rotation: 0, colorDepth: 24, colorSpace: "", depthPerComponent: 8, displayFrequency: 60, monochrome: false,
    ...extra,
  };
}

async function mount(displays: unknown[]) {
  win.graphyDesktop = { listDisplays: () => Promise.resolve(displays), openMonitorQc: () => Promise.resolve() };
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(MonitorQcPanel)));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
const boxes = () => Array.from(host.querySelectorAll<HTMLElement>('[data-testid="mqc-layout-box"]'));
const rows = () => Array.from(host.querySelectorAll<HTMLElement>('[data-testid="mqc-display-row"]'));
const row = (id: number) => rows().find((r) => r.dataset.id === String(id))!;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete win.graphyDesktop;
});

describe("モニター診断（配置の略図・並び・向き・画素数）", () => {
  it("縦・縦・横の 3 枚（OS の順は並び順と違う）: 略図の番号・向きと、表の向き・画素数・MP が出る。既存の列は残る", async () => {
    await mount([
      disp(1, 1200, 0, 1200, 1920), // 2 番目（縦）
      disp(2, 2400, 0, 1920, 1080), // 3 番目（横）
      disp(3, 0, 0, 1200, 1920, 1.25), // 1 番目（縦・拡大率 1.25 → 物理 1500×2400）
    ]);
    expect(boxes()).toHaveLength(3);
    expect(boxes().map((b) => [b.dataset.id, b.dataset.order, b.dataset.orientation])).toEqual([
      ["1", "2", "portrait"],
      ["2", "3", "landscape"],
      ["3", "1", "portrait"],
    ]);
    expect(row(3).dataset).toMatchObject({ order: "1", orientation: "portrait", physical: "1500×2400", mp: "3.6" });
    expect(row(1).dataset).toMatchObject({ order: "2", orientation: "portrait", physical: "1200×1920", mp: "2.3" });
    expect(row(2).dataset).toMatchObject({ order: "3", orientation: "landscape", physical: "1920×1080", mp: "2.1" });
    // 既存の表の中身（解像度・倍率・Hz・パターン表示ボタン）が残る
    const text = row(3).textContent ?? "";
    expect(text).toContain("1200×1920");
    expect(text).toContain("×1.25");
    expect(text).toContain("60");
    expect(row(3).querySelector("button")).not.toBeNull();
    // 診断用モニターを自動判定しない旨の注記
    expect(host.textContent).toMatch(/not identified automatically|判定しません/);
  });

  it("id が同じ数値になる 2 枚（Linux の大きな id）でも、位置で正しく出る", async () => {
    const big = 25442431418447940;
    await mount([disp(big, 1200, 0, 1200, 1920), disp(big + 1, 0, 0, 1920, 1080)]);
    expect(rows().map((r) => [r.dataset.order, r.dataset.orientation])).toEqual([["2", "portrait"], ["1", "landscape"]]);
    expect(boxes().map((b) => b.dataset.order)).toEqual(["2", "1"]);
  });

  it("既定のまま（1 枚だけ）: 1 つの箱で、壊れず出る。割り切れない拡大率は「≈」", async () => {
    await mount([disp(1, 0, 0, 1366, 768, 1.25)]);
    expect(boxes()).toHaveLength(1);
    expect(boxes()[0].dataset).toMatchObject({ order: "1", orientation: "landscape" });
    expect(row(1).dataset.physical).toBe("≈1708×960");
  });

  it("壊れたモニター（bounds が無い・幅 0）が混ざっても落ちず、「不明」と出て、略図には含めない", async () => {
    await mount([disp(1, 0, 0, 1920, 1080), { ...disp(2, 0, 0, 1, 1), bounds: undefined }, disp(3, 1920, 0, 0, 1080)]);
    expect(boxes()).toHaveLength(1);
    expect(rows()).toHaveLength(3);
    expect(row(1).dataset.order).toBe("1");
    for (const id of [2, 3]) {
      expect(row(id).dataset.order).toBe("");
      expect(row(id).textContent).toMatch(/Unknown|不明/);
    }
  });

  it("モニターが 0 枚のときは略図も表も出ない（従来の案内のまま）", async () => {
    await mount([]);
    expect(boxes()).toHaveLength(0);
    expect(rows()).toHaveLength(0);
  });
});

// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// ホイール診断パネルの DOM の煙テスト: 実際に描画し、枠の上のホイールが記録され、外は記録されないこと、クリア、コピー。
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { WHEEL_FINE_PX } from "../viewer/wheelScroll";
import { WheelDiagnosticsPanel } from "./WheelDiagnosticsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const rows = () => Array.from(host.querySelectorAll<HTMLElement>('[data-testid="wheel-diag-row"]'));

async function wheel(target: HTMLElement, deltaY: number, deltaMode = 0): Promise<WheelEvent> {
  const e = new WheelEvent("wheel", { deltaY, deltaMode, bubbles: true, cancelable: true });
  await act(async () => {
    target.dispatchEvent(e);
  });
  return e;
}

beforeEach(async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(WheelDiagnosticsPanel)));
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe("ホイール診断パネル", () => {
  it("開いた直後は 0 件。枠の上のホイールが、送った値のまま表に出て、ビューアと同じ規則のスライス数が数えられる", async () => {
    expect(q("wheel-diag-summary").dataset.count).toBe("0");
    expect(rows()).toHaveLength(0);

    const pad = q("wheel-diag-pad");
    for (let i = 0; i < 3; i++) {
      const e = await wheel(pad, 100);
      expect(e.defaultPrevented).toBe(true); // 枠の上ではダイアログがスクロールしない
    }
    expect(rows()).toHaveLength(3);
    expect(rows().every((r) => r.dataset.dy === "100" && r.dataset.mode === "0" && r.dataset.step === "1")).toBe(true);
    expect(q("wheel-diag-summary").dataset.count).toBe("3");
    expect(q("wheel-diag-summary").dataset.slices).toBe("3");

    // 細かい連続（4px を 20 回 = 80px → 2 スライス）。続きの 3 件に足される
    for (let i = 0; i < 20; i++) await wheel(pad, 4);
    expect(q("wheel-diag-summary").dataset.count).toBe("23");
    expect(q("wheel-diag-summary").dataset.slices).toBe("5");
    expect(rows().length).toBeLessThanOrEqual(40);
  });

  it("枠の外のホイールは記録しない・止めない（負例）", async () => {
    const e = await wheel(host, 100);
    expect(e.defaultPrevented).toBe(false);
    expect(q("wheel-diag-summary").dataset.count).toBe("0");
  });

  it("クリアで 0 件に戻り、端数も捨てる", async () => {
    const pad = q("wheel-diag-pad");
    for (let i = 0; i < 9; i++) await wheel(pad, 4); // 36px: まだ 1 スライスに達していない
    expect(q("wheel-diag-summary").dataset.slices).toBe("0");
    await act(async () => {
      q("wheel-diag-clear").click();
    });
    expect(q("wheel-diag-summary").dataset.count).toBe("0");
    expect(rows()).toHaveLength(0);
    await wheel(pad, 4); // 端数が残っていれば 40px に達して 1 になる
    expect(q("wheel-diag-summary").dataset.slices).toBe("0");
  });

  it("コピーは clipboard.writeText を呼び、レポートにビューアの定数が入る。失敗したら案内を出す", async () => {
    await wheel(q("wheel-diag-pad"), 100);
    const write = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
    await act(async () => {
      q("wheel-diag-copy").click();
    });
    expect(write).toHaveBeenCalledTimes(1);
    const text = (write.mock.calls[0] as unknown as string[])[0];
    expect(text).toContain(`${WHEEL_FINE_PX}px で 1 スライス`);
    expect(text).toContain("イベント数: 1");
    expect((q("wheel-diag-report") as HTMLTextAreaElement).value).toBe(text);

    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true });
    await act(async () => {
      q("wheel-diag-copy").click();
    });
    expect(host.textContent).toMatch(/Could not copy|コピーできませんでした/);
  });
});

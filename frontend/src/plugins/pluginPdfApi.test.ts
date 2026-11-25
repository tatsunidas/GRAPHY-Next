/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPdf } from "./pluginPdfApi";
import { minEffectOf } from "./hostEffects";

const setDesktop = (d: unknown) => { (globalThis as unknown as { window: unknown }).window = { graphyDesktop: d }; };

describe("host.renderPdf", () => {
  afterEach(() => { delete (globalThis as { window?: unknown }).window; });

  it("デスクトップ以外では desktop-only（web では使えない）", async () => {
    setDesktop(undefined);
    expect(await renderPdf({ html: "<p>x</p>" })).toEqual({ ok: false, error: "desktop-only" });
  });

  it("空の HTML は main へ送らずに bad-request（負例）", async () => {
    const f = vi.fn();
    setDesktop({ renderPdf: f });
    expect(await renderPdf({ html: "" })).toEqual({ ok: false, error: "bad-request" });
    expect(f).not.toHaveBeenCalled();
  });

  it("main の結果をそのまま返し、main が落ちても例外を投げない", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);
    setDesktop({ renderPdf: vi.fn(async () => ({ ok: true, bytes })) });
    expect(await renderPdf({ html: "<p>x</p>", pageSize: "A4" })).toEqual({ ok: true, bytes });
    setDesktop({ renderPdf: vi.fn(async () => { throw new Error("ipc"); }) });
    expect(await renderPdf({ html: "<p>x</p>" })).toEqual({ ok: false, error: "render-failed" });
  });

  it("effect は display（write ではない）として表に載っている", () => {
    expect(minEffectOf("renderPdf")).toBe("display");
  });
});

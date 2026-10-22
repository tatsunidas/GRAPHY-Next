import { describe, expect, it } from "vitest";
import type { AiResolveResult } from "../../desktopBridge";
import { appendText, needsConfirm, outcomeOf, readinessOf } from "./voiceFlow";

const ok = (over: Partial<Extract<AiResolveResult, { ok: true }>> = {}): AiResolveResult => ({
  ok: true, providerId: "p", label: "P", kind: "openai", model: "m", endpointHost: "h.example", hasApiKey: true, ...over,
});

describe("voiceFlow", () => {
  it("readinessOf: 解決できない／鍵が無い／できる（ローカル・平文の印も）", () => {
    expect(readinessOf(null).kind).toBe("noProvider");
    expect(readinessOf({ ok: false, error: "no-provider-for-capability" } as AiResolveResult).kind).toBe("noProvider");
    expect(readinessOf(ok({ hasApiKey: false, label: "Cloud" }))).toEqual({ kind: "noKey", label: "Cloud" });
    expect(readinessOf(ok({ local: true, endpointHost: "127.0.0.1:1" }))).toEqual({ kind: "ready", local: true, host: "127.0.0.1:1", plaintext: false });
  });

  it("needsConfirm: クラウドは最初の 1 回だけ／ローカルは出さない／準備できていなければ出さない", () => {
    const cloud = readinessOf(ok());
    const local = readinessOf(ok({ local: true }));
    expect(needsConfirm(cloud, false)).toBe(true);
    expect(needsConfirm(cloud, true)).toBe(false);
    expect(needsConfirm(local, false)).toBe(false);
    expect(needsConfirm({ kind: "noProvider" }, false)).toBe(false);
  });

  it("outcomeOf: 文字は trim／空は成功にしない／エラーは区別", () => {
    const prov = { providerId: "p", model: "m", endpointHost: "h", local: true };
    expect(outcomeOf({ ok: true, text: "  こんにちは \n", provenance: prov })).toEqual({ kind: "text", text: "こんにちは", degraded: false });
    expect(outcomeOf({ ok: true, text: "x", degraded: true, provenance: prov })).toMatchObject({ degraded: true });
    expect(outcomeOf({ ok: true, text: "   ", provenance: prov })).toMatchObject({ kind: "error", code: "empty" });
    expect(outcomeOf({ ok: false, error: "empty-transcript" })).toMatchObject({ code: "empty" });
    expect(outcomeOf({ ok: false, error: "no-api-key" })).toEqual({ kind: "error", code: "failed", error: "no-api-key" });
  });

  it("appendText: 空なら置く／空白で区切る／改行や空白の後ろはそのまま", () => {
    expect(appendText("", "a")).toBe("a");
    expect(appendText("x", "a")).toBe("x a");
    expect(appendText("x\n", "a")).toBe("x\na");
    expect(appendText("x ", "a")).toBe("x a");
  });
});

import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState, type ChatState } from "./chatState";

const prov = { providerId: "p", kind: "openai", model: "m", endpointHost: "h" };
const sent = (): ChatState => chatReducer(initialChatState, { type: "send", text: "q", images: [], sources: [] });

describe("chatReducer", () => {
  it("send adds user + pending assistant; double send ignored", () => {
    const s = sent();
    expect(s.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(s.pending).toBe(2);
    expect(chatReducer(s, { type: "send", text: "x", images: [], sources: [] })).toBe(s);
  });
  it("delta appends, done takes final text and clears pending", () => {
    let s = chatReducer(sent(), { type: "delta", text: "ab" });
    s = chatReducer(s, { type: "delta", text: "c" });
    expect(s.messages[1].text).toBe("abc");
    s = chatReducer(s, { type: "done", result: { ok: true, text: "abcd", provenance: prov, degraded: true } });
    expect(s.pending).toBeNull();
    expect(s.messages[1]).toMatchObject({ text: "abcd", degraded: true });
  });
  it("done without text keeps streamed text", () => {
    let s = chatReducer(sent(), { type: "delta", text: "xy" });
    s = chatReducer(s, { type: "done", result: { ok: true, provenance: prov } });
    expect(s.messages[1].text).toBe("xy");
  });
  it("error / canceled are distinguished", () => {
    expect(chatReducer(sent(), { type: "done", result: { ok: false, error: "busy" } }).messages[1].error).toBe("busy");
    const c = chatReducer(sent(), { type: "done", result: { ok: false, error: "canceled" } }).messages[1];
    expect(c.canceled).toBe(true);
    expect(c.error).toBeUndefined();
  });
  it("clear only when idle", () => {
    const s = sent();
    expect(chatReducer(s, { type: "clear" })).toBe(s);
    const done = chatReducer(s, { type: "cancel" });
    expect(chatReducer(done, { type: "clear" }).messages).toEqual([]);
  });
  it("delta with nothing pending is ignored", () => {
    expect(chatReducer(initialChatState, { type: "delta", text: "z" })).toBe(initialChatState);
  });
});

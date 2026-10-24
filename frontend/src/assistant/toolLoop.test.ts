import { describe, expect, it } from "vitest";
import { MAX_ROUNDS, runToolLoop, type LoopDeps } from "./toolLoop";
import { buildTools } from "./actions/registry";
import type { AiChatResult, AiToolCall } from "../desktopBridge";

const prov = { providerId: "p", kind: "openai", model: "m", endpointHost: "h" };
const text = (t: string): AiChatResult => ({ ok: true, text: t, provenance: prov });
const calls = (...c: AiToolCall[]): AiChatResult => ({ ok: true, toolCalls: c, provenance: prov });

function setup(script: AiChatResult[], viewerReply?: (cmd: unknown) => unknown) {
  const sent: unknown[][] = [];
  const viewerCalls: unknown[] = [];
  const ev: string[] = [];
  let i = 0;
  const deps: LoopDeps = {
    chat: async (m) => {
      sent.push(JSON.parse(JSON.stringify(m)));
      return script[Math.min(i++, script.length - 1)];
    },
    viewer: async (cmd) => {
      viewerCalls.push(cmd);
      return (viewerReply ? viewerReply(cmd) : { ok: true, inverse: [{ id: "flipH", params: {} }] }) as never;
    },
    onAction: (a) => ev.push(`add:${a.name}:${a.status}`),
    onActionUpdate: (id, p) => ev.push(`upd:${id}:${p.status}`),
    onProposal: (p) => ev.push(`proposal:${p.title}`),
    onRoundDone: () => ev.push("round"),
    aborted: () => false,
  };
  return { deps, sent, viewerCalls, ev };
}

describe("runToolLoop", () => {
  it("executes the tool, feeds the result back and returns the final text", async () => {
    const s = setup([calls({ id: "c1", name: "setWindowLevel", args: { center: 40, width: 400 } }), text("done")]);
    const r = await runToolLoop([{ role: "user", text: "hi" }], buildTools(), s.deps);
    expect(r).toMatchObject({ ok: true, text: "done" });
    expect(s.viewerCalls).toEqual([{ kind: "action", id: "setWindowLevel", params: { center: 40, width: 400 } }]);
    const second = s.sent[1] as { role: string; toolCallId?: string; text?: string }[];
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(second[2].toolCallId).toBe("c1");
    expect(JSON.parse(second[2].text!)).toEqual({ ok: true }); // inverse is not sent to the model
    expect(s.ev).toEqual(["round", "add:setWindowLevel:running", "upd:c1:done"]);
  });
  it("negative: invalid args are not sent to the viewer, the model gets the error", async () => {
    const s = setup([calls({ id: "c1", name: "setWindowLevel", args: { center: 1, width: -3 } }), text("ok")]);
    await runToolLoop([{ role: "user", text: "x" }], buildTools(), s.deps);
    expect(s.viewerCalls).toEqual([]);
    const tool = (s.sent[1] as { role: string; text?: string }[])[2];
    expect(JSON.parse(tool.text!)).toEqual({ ok: false, error: "out-of-range:width" });
  });
  it("negative: argsError from the gateway and unknown / data tools are never executed", async () => {
    const s = setup([
      calls(
        { id: "a", name: "flipH", args: {}, argsError: "bad json" },
        { id: "b", name: "clearRois", args: {} },
        { id: "c", name: "saveDerivedSeries", args: {} },
      ),
      text("ok"),
    ]);
    await runToolLoop([{ role: "user", text: "x" }], buildTools(), s.deps);
    expect(s.viewerCalls).toEqual([]);
    const tools = (s.sent[1] as { role: string; text?: string }[]).filter((m) => m.role === "tool");
    expect(tools.map((t) => JSON.parse(t.text!).ok)).toEqual([false, false, false]);
  });
  it("propose_steps shows a card and executes nothing", async () => {
    const s = setup([calls({ id: "p", name: "propose_steps", args: { title: "ROI を描く", steps: ["a", "b"] } }), text("ok")]);
    await runToolLoop([{ role: "user", text: "x" }], buildTools(), s.deps);
    expect(s.viewerCalls).toEqual([]);
    expect(s.ev).toContain("proposal:ROI を描く");
  });
  it("getState goes through the viewer as a read", async () => {
    const s = setup([calls({ id: "g", name: "getState", args: {} }), text("ok")], () => ({ ok: true, state: { tiles: [] } }));
    await runToolLoop([{ role: "user", text: "x" }], buildTools(), s.deps);
    expect(s.viewerCalls).toEqual([{ kind: "getState" }]);
  });
  it("stops after MAX_ROUNDS when the model keeps calling tools", async () => {
    const s = setup([calls({ id: "c", name: "flipH", args: {} })]);
    const r = await runToolLoop([{ role: "user", text: "x" }], buildTools(), s.deps);
    expect(r).toEqual({ ok: false, error: "max-rounds" });
    expect(s.sent.length).toBe(MAX_ROUNDS);
  });
  it("chat failure is returned as is", async () => {
    const s = setup([{ ok: false, error: "busy" }]);
    expect(await runToolLoop([{ role: "user", text: "x" }], buildTools(), s.deps)).toEqual({ ok: false, error: "busy" });
  });
  it("abort between tool calls stops without executing the rest", async () => {
    const s = setup([calls({ id: "a", name: "flipH", args: {} }, { id: "b", name: "flipV", args: {} }), text("x")]);
    let n = 0;
    s.deps.aborted = () => n++ > 0;
    const r = await runToolLoop([{ role: "user", text: "x" }], buildTools(), s.deps);
    expect(r).toMatchObject({ ok: false, error: "canceled" });
    expect(s.viewerCalls.length).toBe(1);
  });
  it("getMeasurements: reads through the viewer and marks the result untrusted", async () => {
    const s = setup([calls({ id: "m1", name: "getMeasurements", args: {} }), text("ok")], () => ({ ok: true, measurements: { rois: [{ roi: "roi1", mean: 5 }] } }));
    await runToolLoop([{ role: "user", text: "x" }], buildTools(), s.deps);
    expect(s.viewerCalls).toEqual([{ kind: "getMeasurements" }]);
    const tool = (s.sent[1] as { role: string; text?: string }[])[2];
    expect(JSON.parse(tool.text!)).toEqual({ ok: true, rois: [{ roi: "roi1", mean: 5 }], untrusted: true });
  });
  it("getMeasurements: a truncated (string) result is not spread as a structure", async () => {
    const s = setup([calls({ id: "m1", name: "getMeasurements", args: {} }), text("ok")], () => ({ ok: true, measurements: '{"rois":[{"roi":"ro' }));
    await runToolLoop([{ role: "user", text: "x" }], buildTools(), s.deps);
    const tool = (s.sent[1] as { role: string; text?: string }[])[2];
    expect(JSON.parse(tool.text!)).toEqual({ ok: true, measurements: '{"rois":[{"roi":"ro', truncated: true, untrusted: true });
  });
  it("getMeasurements: refused in robot mode (negative)", async () => {
    const s = setup([calls({ id: "m1", name: "getMeasurements", args: {} }), text("ok")]);
    await runToolLoop([{ role: "user", text: "x" }], buildTools(), { ...s.deps, mode: "robot" });
    expect(s.viewerCalls).toEqual([]);
    const tool = (s.sent[1] as { role: string; text?: string }[])[2];
    expect(JSON.parse(tool.text!)).toEqual({ ok: false, error: "not-allowed-in-robot-mode" });
  });
});

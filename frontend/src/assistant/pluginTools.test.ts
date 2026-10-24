import { describe, expect, it } from "vitest";
import { runToolLoop, type LoopDeps } from "./toolLoop";
import { validatePluginArgs, type PluginToolEntry } from "./pluginTools";
import { executePluginTool, type PluginToolDeps } from "../viewer2d/pluginToolBridge";
import type { PluginManifest } from "../plugins/pluginTypes";
import type { AiChatResult, AiToolCall } from "../desktopBridge";

const PARAMS = {
  type: "object",
  properties: {
    label: { type: "string", maxLength: 10, description: "l" },
    n: { type: "integer", minimum: 1, maximum: 5, description: "n" },
    mode: { type: "string", enum: ["a", "b"], description: "m" },
  },
  required: ["n"],
};

describe("validatePluginArgs", () => {
  it("accepts in-range values", () => {
    expect(validatePluginArgs(PARAMS, { n: 3, label: "x", mode: "a" })).toEqual({ ok: true, params: { label: "x", n: 3, mode: "a" } });
    expect(validatePluginArgs(PARAMS, { n: 1 }).ok).toBe(true);
  });
  it("rejects unknown keys, missing required, wrong types, range, NaN, enum miss, empty/long strings", () => {
    for (const a of [{}, { n: 0 }, { n: 6 }, { n: 1.5 }, { n: NaN }, { n: "3" }, { n: 1, extra: 1 }, { n: 1, mode: "c" }, { n: 1, label: "" }, { n: 1, label: "x".repeat(11) }, { n: 1, ["__proto__"]: 1 }, [1]]) {
      expect(validatePluginArgs(PARAMS, a).ok, JSON.stringify(a)).toBe(false);
    }
  });
  it("a spec without bounds is refused (never trusts an unvalidated shape)", () => {
    expect(validatePluginArgs({ properties: { n: { type: "integer" } } }, { n: 1 }).ok).toBe(false);
    expect(validatePluginArgs({ properties: { o: { type: "object" } } }, { o: {} }).ok).toBe(false);
    expect(validatePluginArgs(null, {}).ok).toBe(false);
  });
});

const entry: PluginToolEntry = {
  name: "plugin__demo__measure",
  pluginId: "demo",
  pluginName: "DEMO",
  tool: "measure",
  description: "[plugin: DEMO] x",
  parameters: PARAMS,
  enabled: true,
};
const prov = { providerId: "p", kind: "openai", model: "m", endpointHost: "h" };
const text = (t: string): AiChatResult => ({ ok: true, text: t, provenance: prov });
const calls = (...c: AiToolCall[]): AiChatResult => ({ ok: true, toolCalls: c, provenance: prov });

function setup(script: AiChatResult[], over: Partial<LoopDeps> = {}) {
  const sent: { role: string; text?: string }[][] = [];
  const relayed: unknown[] = [];
  const ev: string[] = [];
  let i = 0;
  const deps: LoopDeps = {
    chat: async (m) => {
      sent.push(JSON.parse(JSON.stringify(m)));
      return script[Math.min(i++, script.length - 1)];
    },
    viewer: async () => ({ ok: true }),
    pluginTools: [entry],
    pluginTool: async (cmd) => {
      relayed.push(cmd);
      return { ok: true, source: "plugin:demo", untrusted: true, data: { v: 1 } };
    },
    onAction: (a) => ev.push(`add:${a.name}:${a.status}`),
    onActionUpdate: (id, p) => ev.push(`upd:${id}:${p.status}`),
    onProposal: () => {},
    onRoundDone: () => {},
    aborted: () => false,
    ...over,
  };
  return { deps, sent, relayed, ev };
}

describe("toolLoop plugin tools", () => {
  it("relays a valid call and returns the untrusted-wrapped result to the model", async () => {
    const s = setup([calls({ id: "c1", name: entry.name, args: { n: 2 } }), text("done")]);
    await runToolLoop([{ role: "user", text: "x" }], [], s.deps);
    expect(s.relayed).toEqual([{ kind: "pluginTool", name: entry.name, params: { n: 2 } }]);
    expect(JSON.parse(s.sent[1][2].text!)).toEqual({ ok: true, source: "plugin:demo", untrusted: true, data: { v: 1 } });
  });
  it("negative: invalid args, a name not in the enabled list, and robot mode are never relayed", async () => {
    const bad = setup([calls({ id: "c1", name: entry.name, args: { n: 99 } }), text("ok")]);
    await runToolLoop([{ role: "user", text: "x" }], [], bad.deps);
    expect(bad.relayed).toEqual([]);
    expect(JSON.parse(bad.sent[1][2].text!)).toEqual({ ok: false, error: "out-of-range:n" });

    const unknown = setup([calls({ id: "c1", name: "plugin__other__x", args: {} }), text("ok")]);
    await runToolLoop([{ role: "user", text: "x" }], [], unknown.deps);
    expect(unknown.relayed).toEqual([]);
    expect(JSON.parse(unknown.sent[1][2].text!)).toEqual({ ok: false, error: "unknown-tool" });

    const off = setup([calls({ id: "c1", name: entry.name, args: { n: 1 } }), text("ok")], { pluginTools: [] });
    await runToolLoop([{ role: "user", text: "x" }], [], off.deps);
    expect(off.relayed).toEqual([]);

    const robot = setup([calls({ id: "c1", name: entry.name, args: { n: 1 } }), text("ok")], { mode: "robot" });
    await runToolLoop([{ role: "user", text: "x" }], [], robot.deps);
    expect(robot.relayed).toEqual([]);
  });
  it("a declined/failed relay shows the error and still lets the loop finish", async () => {
    const s = setup([calls({ id: "c1", name: entry.name, args: { n: 1 } }), text("ok")], { pluginTool: async () => ({ ok: false, error: "declined" }) });
    const r = await runToolLoop([{ role: "user", text: "x" }], [], s.deps);
    expect(r).toMatchObject({ ok: true, text: "ok" });
    expect(s.ev).toContain("upd:c1:failed");
  });
});

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest =>
  ({
    id: "demo",
    name: "DEMO",
    version: "1",
    permissions: ["ai-tools"],
    aiTools: [{ name: "measure", description: "d", effect: "read", parameters: PARAMS }],
    ...over,
  }) as PluginManifest;

function bridgeDeps(over: Partial<PluginToolDeps> = {}, m: PluginManifest = manifest()) {
  const ran: unknown[] = [];
  const deps: PluginToolDeps = {
    manifests: async () => [m],
    load: async () => async (a) => {
      ran.push(a);
      return { v: 1 };
    },
    ...over,
  };
  return { deps, ran };
}

describe("executePluginTool (2D window)", () => {
  it("runs a declared tool with validated args", async () => {
    const b = bridgeDeps();
    expect(await executePluginTool(b.deps, { pluginId: "demo", tool: "measure", params: { n: 2 } })).toEqual({ ok: true, data: { v: 1 } });
    expect(b.ran).toEqual([{ n: 2 }]);
  });
  it("negative: undeclared tool / unknown plugin / no ai-tools permission / write effect / bad args never run", async () => {
    for (const [cmd, m] of [
      [{ pluginId: "demo", tool: "nope", params: {} }, manifest()],
      [{ pluginId: "other", tool: "measure", params: { n: 1 } }, manifest()],
      [{ pluginId: "demo", tool: "measure", params: { n: 1 } }, manifest({ permissions: [] })],
      [{ pluginId: "demo", tool: "measure", params: { n: 1 } }, manifest({ aiTools: [{ name: "measure", description: "d", effect: "write" as never, parameters: PARAMS }] })],
      [{ pluginId: "demo", tool: "measure", params: { n: 99 } }, manifest()],
      [{ pluginId: 5, tool: "measure", params: {} }, manifest()],
    ] as const) {
      const b = bridgeDeps({}, m);
      const r = await executePluginTool(b.deps, cmd);
      expect(r.ok, JSON.stringify(cmd)).toBe(false);
      expect(b.ran).toEqual([]);
    }
  });
  it("missing function, thrown error (message not returned) and timeout", async () => {
    expect(await executePluginTool(bridgeDeps({ load: async () => null }).deps, { pluginId: "demo", tool: "measure", params: { n: 1 } })).toEqual({ ok: false, error: "no-function" });
    const thrown = await executePluginTool(
      bridgeDeps({ load: async () => () => { throw new Error("SECRET PATIENT NAME"); } }).deps,
      { pluginId: "demo", tool: "measure", params: { n: 1 } },
    );
    expect(thrown).toEqual({ ok: false, error: "plugin-error" });
    const slow = await executePluginTool(
      bridgeDeps({ timeoutMs: 20, load: async () => () => new Promise(() => {}) }).deps,
      { pluginId: "demo", tool: "measure", params: { n: 1 } },
    );
    expect(slow).toEqual({ ok: false, error: "timeout" });
  });
});

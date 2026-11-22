import { describe, expect, it, vi } from "vitest";
import {
  computeToolBindings,
  DEFAULT_MOUSE_BINDINGS,
  parseMouseBindings,
  type ToolNames,
} from "./mouseBindings";

const N: ToolNames = { windowLevel: "WindowLevel", pan: "Pan", zoom: "Zoom" };

describe("parseMouseBindings", () => {
  it("設定が無ければ既定（中=パン・右=ズーム）", () => {
    expect(parseMouseBindings(undefined)).toEqual(DEFAULT_MOUSE_BINDINGS);
    expect(parseMouseBindings({})).toEqual({ middle: "pan", right: "zoom" });
  });
  it("未知の値は既定に置き換え、有効な値はそのまま", () => {
    expect(parseMouseBindings({ "mouse.middle": "bogus", "mouse.right": "windowLevel" })).toEqual({
      middle: "pan",
      right: "windowLevel",
    });
    expect(parseMouseBindings({ "mouse.middle": "none" }).middle).toBe("none");
  });
});

describe("computeToolBindings", () => {
  it("既定の表は従来の直書きと同じ（左=W/L のとき W/L=主, Pan=中, Zoom=右+2 本指）", () => {
    expect(computeToolBindings("WindowLevel", DEFAULT_MOUSE_BINDINGS, N, { touchZoom: true })).toEqual({
      WindowLevel: ["primary"],
      Pan: ["auxiliary"],
      Zoom: ["secondary", "touch2"],
    });
  });
  it("既定で左=Pan のとき Pan は主+中、Zoom は右+2 本指（従来の isPan）", () => {
    expect(computeToolBindings("Pan", DEFAULT_MOUSE_BINDINGS, N, { touchZoom: true })).toEqual({
      Pan: ["primary", "auxiliary"],
      Zoom: ["secondary", "touch2"],
    });
  });
  it("既定で左=Zoom のとき Zoom は主+右+2 本指、Pan は中（従来の isZoom）", () => {
    expect(computeToolBindings("Zoom", DEFAULT_MOUSE_BINDINGS, N, { touchZoom: true })).toEqual({
      Zoom: ["primary", "secondary", "touch2"],
      Pan: ["auxiliary"],
    });
  });
  it("左=計測ツールでも、中・右は表どおり", () => {
    expect(computeToolBindings("Length", DEFAULT_MOUSE_BINDINGS, N, { touchZoom: true })).toEqual({
      Length: ["primary"],
      Pan: ["auxiliary"],
      Zoom: ["secondary", "touch2"],
    });
  });
  it("右=W/L にすると W/L が右に付き、Zoom は右に付かない（負例）", () => {
    const r = computeToolBindings("Length", { middle: "pan", right: "windowLevel" }, N, { touchZoom: true });
    expect(r.WindowLevel).toEqual(["secondary"]);
    expect(r.Zoom).toEqual(["touch2"]);
    expect(Object.values(r).flat().filter((b) => b === "secondary")).toHaveLength(1);
  });
  it("中=なし・右=なし なら、そのボタンはどのツールにも付かない。2 本指の Zoom は残る", () => {
    const r = computeToolBindings("WindowLevel", { middle: "none", right: "none" }, N, { touchZoom: true });
    expect(r).toEqual({ WindowLevel: ["primary"], Zoom: ["touch2"] });
  });
  it("動画（touchZoom=false）は 2 本指を付けない", () => {
    expect(computeToolBindings("WindowLevel", DEFAULT_MOUSE_BINDINGS, N, { touchZoom: false })).toEqual({
      WindowLevel: ["primary"],
      Pan: ["auxiliary"],
      Zoom: ["secondary"],
    });
  });
  it("左と右が同じツールなら 1 つにまとめる", () => {
    expect(computeToolBindings("WindowLevel", { middle: "pan", right: "windowLevel" }, N, { touchZoom: false }).WindowLevel).toEqual([
      "primary",
      "secondary",
    ]);
  });
});

describe("applyMouseBindings（偽の ToolGroup）", () => {
  it("先に全バインドを外してから、求めたバインドだけを付ける", async () => {
    vi.resetModules();
    vi.doMock("@cornerstonejs/tools", () => ({
      Enums: { MouseBindings: { Primary: 1, Secondary: 2, Auxiliary: 4 } },
      PanTool: { toolName: "Pan" },
      ZoomTool: { toolName: "Zoom" },
      WindowLevelTool: { toolName: "WindowLevel" },
    }));
    const { applyMouseBindings } = await import("./mouseBindingsApply");
    const calls: string[] = [];
    const tg = {
      setToolPassive: (n: string, o?: { removeAllBindings?: boolean }) => calls.push(`passive ${n} ${o?.removeAllBindings}`),
      setToolActive: (n: string, o: { bindings: object[] }) => calls.push(`active ${n} ${JSON.stringify(o.bindings)}`),
    };
    applyMouseBindings(tg, ["WindowLevel", "Pan", "Zoom", "Length"], "Length", { middle: "pan", right: "windowLevel" }, { touchZoom: true });
    const firstActive = calls.findIndex((c) => c.startsWith("active"));
    expect(calls.slice(0, firstActive).every((c) => c.endsWith("true"))).toBe(true);
    expect(calls.slice(0, firstActive)).toHaveLength(4);
    expect(calls.slice(firstActive)).toEqual([
      'active Length [{"mouseButton":1}]',
      'active Pan [{"mouseButton":4}]',
      'active WindowLevel [{"mouseButton":2}]',
      'active Zoom [{"numTouchPoints":2}]',
    ]);
    vi.doUnmock("@cornerstonejs/tools");
  });
});

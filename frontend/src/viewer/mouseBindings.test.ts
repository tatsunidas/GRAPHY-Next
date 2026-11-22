import { describe, expect, it, vi } from "vitest";
import {
  computeToolBindings,
  DEFAULT_MOUSE_BINDINGS,
  isMouseSettingKey,
  parseMouseBindings,
  shouldGuardSideButton,
  type MouseBindingTable,
  type ToolNames,
} from "./mouseBindings";

const D = DEFAULT_MOUSE_BINDINGS;
const N: ToolNames = { windowLevel: "WindowLevel", pan: "Pan", zoom: "Zoom" };

describe("parseMouseBindings", () => {
  it("設定が無ければ既定（中=パン・右=ズーム）", () => {
    expect(parseMouseBindings(undefined)).toEqual(DEFAULT_MOUSE_BINDINGS);
    expect(parseMouseBindings({})).toEqual({ middle: "pan", right: "zoom", back: "none", forward: "none" });
  });
  it("未知の値は既定に置き換え、有効な値はそのまま", () => {
    expect(parseMouseBindings({ "mouse.middle": "bogus", "mouse.right": "windowLevel" })).toEqual({
      middle: "pan",
      right: "windowLevel",
      back: "none",
      forward: "none",
    });
    expect(parseMouseBindings({ "mouse.back": "pan", "mouse.forward": "bogus" })).toMatchObject({ back: "pan", forward: "none" });
    expect(parseMouseBindings({ "mouse.middle": "none" }).middle).toBe("none");
  });
});

describe("computeToolBindings", () => {
  it("既定の表は従来の直書きと同じ（左=W/L のとき W/L=主, Pan=中, Zoom=右+2 本指）", () => {
    expect(computeToolBindings("WindowLevel", D, N, { touchZoom: true })).toEqual({
      WindowLevel: ["primary"],
      Pan: ["auxiliary"],
      Zoom: ["secondary", "touch2"],
    });
  });
  it("既定で左=Pan のとき Pan は主+中、Zoom は右+2 本指（従来の isPan）", () => {
    expect(computeToolBindings("Pan", D, N, { touchZoom: true })).toEqual({
      Pan: ["primary", "auxiliary"],
      Zoom: ["secondary", "touch2"],
    });
  });
  it("既定で左=Zoom のとき Zoom は主+右+2 本指、Pan は中（従来の isZoom）", () => {
    expect(computeToolBindings("Zoom", D, N, { touchZoom: true })).toEqual({
      Zoom: ["primary", "secondary", "touch2"],
      Pan: ["auxiliary"],
    });
  });
  it("左=計測ツールでも、中・右は表どおり", () => {
    expect(computeToolBindings("Length", D, N, { touchZoom: true })).toEqual({
      Length: ["primary"],
      Pan: ["auxiliary"],
      Zoom: ["secondary", "touch2"],
    });
  });
  it("右=W/L にすると W/L が右に付き、Zoom は右に付かない（負例）", () => {
    const r = computeToolBindings("Length", { ...D, right: "windowLevel" }, N, { touchZoom: true });
    expect(r.WindowLevel).toEqual(["secondary"]);
    expect(r.Zoom).toEqual(["touch2"]);
    expect(Object.values(r).flat().filter((b) => b === "secondary")).toHaveLength(1);
  });
  it("中=なし・右=なし なら、そのボタンはどのツールにも付かない。2 本指の Zoom は残る", () => {
    const r = computeToolBindings("WindowLevel", { ...D, middle: "none", right: "none" }, N, { touchZoom: true });
    expect(r).toEqual({ WindowLevel: ["primary"], Zoom: ["touch2"] });
  });
  it("動画（touchZoom=false）は 2 本指を付けない", () => {
    expect(computeToolBindings("WindowLevel", D, N, { touchZoom: false })).toEqual({
      WindowLevel: ["primary"],
      Pan: ["auxiliary"],
      Zoom: ["secondary"],
    });
  });
  it("左と右が同じツールなら 1 つにまとめる", () => {
    expect(computeToolBindings("WindowLevel", { ...D, right: "windowLevel" }, N, { touchZoom: false }).WindowLevel).toEqual([
      "primary",
      "secondary",
    ]);
  });
});

describe("サイドボタン（戻る・進む）", () => {
  it("戻る=Pan・進む=Zoom なら、Pan に fourth、Zoom に fifth と 2 本指が付く", () => {
    expect(computeToolBindings("WindowLevel", { ...D, back: "pan", forward: "zoom" }, N, { touchZoom: true })).toEqual({
      WindowLevel: ["primary"],
      Pan: ["auxiliary", "fourth"],
      Zoom: ["secondary", "fifth", "touch2"],
    });
  });
  it("戻る=W/L なら W/L に fourth が付く。戻る・進む=なし（既定）なら何も付かない（負例）", () => {
    expect(computeToolBindings("Length", { ...D, back: "windowLevel" }, N, { touchZoom: false }).WindowLevel).toEqual(["fourth"]);
    const r = computeToolBindings("Length", D, N, { touchZoom: false });
    expect(Object.values(r).flat().some((b) => b === "fourth" || b === "fifth")).toBe(false);
  });
  it("設定キーの判定は 4 つのキーだけ", () => {
    for (const k of ["mouse.middle", "mouse.right", "mouse.back", "mouse.forward"]) expect(isMouseSettingKey(k)).toBe(true);
    expect(isMouseSettingKey("viewer.cineFps")).toBe(false);
  });
  it("既定動作の抑止は、割り当てたサイドボタン（button 3=戻る・4=進む）だけ", () => {
    const t: MouseBindingTable = { ...D, back: "pan" };
    expect(shouldGuardSideButton(3, t)).toBe(true);
    expect(shouldGuardSideButton(4, t)).toBe(false); // 進むは未割り当て
    expect(shouldGuardSideButton(3, D)).toBe(false);
    expect(shouldGuardSideButton(4, D)).toBe(false);
    for (const b of [0, 1, 2]) expect(shouldGuardSideButton(b, { ...D, back: "pan", forward: "zoom" })).toBe(false);
  });
});

describe("applyMouseBindings（偽の ToolGroup）", () => {
  it("先に全バインドを外してから、求めたバインドだけを付ける", async () => {
    vi.resetModules();
    vi.doMock("@cornerstonejs/tools", () => ({
      Enums: { MouseBindings: { Primary: 1, Secondary: 2, Auxiliary: 4, Fourth_Button: 8, Fifth_Button: 16 } },
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
    applyMouseBindings(tg, ["WindowLevel", "Pan", "Zoom", "Length"], "Length", { ...D, right: "windowLevel", back: "pan" }, { touchZoom: true });
    const firstActive = calls.findIndex((c) => c.startsWith("active"));
    expect(calls.slice(0, firstActive).every((c) => c.endsWith("true"))).toBe(true);
    expect(calls.slice(0, firstActive)).toHaveLength(4);
    expect(calls.slice(firstActive)).toEqual([
      'active Length [{"mouseButton":1}]',
      'active Pan [{"mouseButton":4},{"mouseButton":8}]',
      'active WindowLevel [{"mouseButton":2}]',
      'active Zoom [{"numTouchPoints":2}]',
    ]);
    vi.doUnmock("@cornerstonejs/tools");
  });
});

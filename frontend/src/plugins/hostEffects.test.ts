import { describe, expect, it } from "vitest";
import { EffectViolation, HOST_EFFECTS, guardHost, minEffectOf } from "./hostEffects";
import { executePluginTool, type PluginToolDeps } from "../viewer2d/pluginToolBridge";
import type { PluginHost, PluginManifest } from "./pluginTypes";

const calls: string[] = [];
// テストは Viewer2D の枝で触るので、型は緩める
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = { host: any; violated(): string | null };
const guard = (h: PluginHost, e: "read" | "display" | "write"): Loose => guardHost(h, e);
const fake = (): PluginHost =>
  ({
    pluginId: "demo",
    getRois: () => (calls.push("getRois"), []),
    showOverlay: () => (calls.push("showOverlay"), true),
    createRoi: () => (calls.push("createRoi"), "uid"),
    setRoiMeta: () => (calls.push("setRoiMeta"), true),
    saveDerivedSeries: async () => (calls.push("saveDerivedSeries"), { ok: true }),
    db: { searchPatients: () => (calls.push("db.searchPatients"), []) },
    brandNewMember: () => (calls.push("brandNewMember"), 1),
  }) as unknown as PluginHost;

describe("minEffectOf / HOST_EFFECTS", () => {
  it("分類: 読み取り・表示・書き込みの代表と、未分類は write", () => {
    expect(minEffectOf("getRois")).toBe("read");
    expect(minEffectOf("showOverlay")).toBe("display");
    expect(minEffectOf("createRoi")).toBe("write");
    expect(minEffectOf("db")).toBe("write");
    expect(minEffectOf("notInTheTable")).toBe("write");
    expect(minEffectOf("toString")).toBe("write"); // Object.prototype のメンバ名でも表を素通りしない
  });
  it("書き込み系は全部 write（取りこぼし防止の名指し）", () => {
    for (const k of ["setRoiMeta", "createRoi", "removeCreatedRoi", "removeLabelVolume", "saveDerivedSeries", "saveStructuredReport", "saveSegmentation", "saveStore", "deleteStore", "runBackend", "ai", "file"]) {
      expect(HOST_EFFECTS[k as keyof typeof HOST_EFFECTS], k).toBe("write");
    }
  });
});

describe("guardHost", () => {
  it("read: 読み取りは通り、display / write のメンバは触れた時点で止まる（呼ばれない）", () => {
    calls.length = 0;
    const g = guard(fake(), "read");
    expect(g.host.getRois()).toEqual([]);
    expect(() => g.host.showOverlay).toThrow(EffectViolation);
    expect(() => g.host.createRoi).toThrow(EffectViolation);
    expect(() => g.host.db).toThrow(EffectViolation);
    expect(calls).toEqual(["getRois"]);
    expect(g.violated()).toBe("showOverlay");
  });
  it("display: 表示は通り、write は止まる", () => {
    calls.length = 0;
    const g = guard(fake(), "display");
    expect(g.host.getRois()).toEqual([]);
    expect(g.host.showOverlay(undefined, {} as never)).toBe(true);
    expect(() => g.host.setRoiMeta).toThrow(EffectViolation);
    expect(() => g.host.saveDerivedSeries).toThrow(EffectViolation);
    expect(calls).toEqual(["getRois", "showOverlay"]);
    expect(g.violated()).toBe("setRoiMeta");
  });
  it("write: 全部通る（従来どおり・記録なし）", () => {
    calls.length = 0;
    const g = guard(fake(), "write");
    expect(g.host.createRoi({} as never)).toBe("uid");
    expect(g.host.setRoiMeta("u", {})).toBe(true);
    expect(calls).toEqual(["createRoi", "setRoiMeta"]);
    expect(g.violated()).toBeNull();
  });
  it("表に無いメンバは read / display からは止まる。存在しないメンバの参照は素通し（越権の記録なし）", () => {
    const g = guard(fake(), "display");
    expect(() => g.host.brandNewMember).toThrow(EffectViolation);
    const h = guard(fake(), "read");
    expect(h.host.doesNotExist).toBeUndefined();
    expect(h.violated()).toBeNull();
  });
  it("プラグインが例外を握りつぶしても越権の記録は残る", () => {
    const g = guard(fake(), "read");
    try {
      void g.host.createRoi;
    } catch {
      /* 握りつぶし */
    }
    expect(g.violated()).toBe("createRoi");
  });
});

const PARAMS = { type: "object", properties: {}, required: [] };
const manifest = (effect: string): PluginManifest =>
  ({ id: "demo", name: "D", version: "1", permissions: ["ai-tools"], aiTools: [{ name: "t", description: "d", effect, parameters: PARAMS }] }) as unknown as PluginManifest;

describe("executePluginTool × effect", () => {
  it("load には manifest の effect を渡す（レンダラ供給の effect は無視）", async () => {
    const seen: string[] = [];
    const deps: PluginToolDeps = {
      manifests: async () => [manifest("display")],
      load: async (_m, _t, effect) => {
        seen.push(effect);
        return async () => 1;
      },
    };
    await executePluginTool(deps, { pluginId: "demo", tool: "t", params: {}, effect: "write" } as never);
    expect(seen).toEqual(["display"]);
  });
  it("EffectViolation は effect-violation（本文はモデルへ返さない）、通常の例外は plugin-error のまま", async () => {
    const viol: PluginToolDeps = { manifests: async () => [manifest("read")], load: async () => async () => { throw new EffectViolation("createRoi", "read"); } };
    expect(await executePluginTool(viol, { pluginId: "demo", tool: "t", params: {} })).toEqual({ ok: false, error: "effect-violation" });
    const plain: PluginToolDeps = { manifests: async () => [manifest("read")], load: async () => async () => { throw new Error("boom"); } };
    expect(await executePluginTool(plain, { pluginId: "demo", tool: "t", params: {} })).toEqual({ ok: false, error: "plugin-error" });
  });
});

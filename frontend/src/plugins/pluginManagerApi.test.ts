import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectPluginFromFile, installPluginFromFile, pickLocalPackage } from "./pluginManagerApi";

const file = (name: string, body = "x") => new File([body], name);

afterEach(() => vi.unstubAllGlobals());

describe("pickLocalPackage", () => {
  it("zip だけなら署名なし（従来どおり）", async () => {
    const p = await pickLocalPackage([file("a-1.0.0.zip")]);
    expect(p?.zip.name).toBe("a-1.0.0.zip");
    expect(p?.signature).toBeUndefined();
    expect(p?.publicKey).toBeUndefined();
  });

  it("同じ名前の .minisig と .pub を中身つきで取り出す（選んだ順に依らない）", async () => {
    const p = await pickLocalPackage([file("a-1.0.0.zip.minisig", "SIG"), file("minisign.pub", "PUB"), file("a-1.0.0.zip")]);
    expect(p?.zip.name).toBe("a-1.0.0.zip");
    expect(p?.signature).toBe("SIG");
    expect(p?.publicKey).toBe("PUB");
  });

  it("別の zip の .minisig が複数あるときは取り違えない", async () => {
    const p = await pickLocalPackage([file("a.zip"), file("b.zip.minisig", "B"), file("a.zip.minisig", "A")]);
    expect(p?.signature).toBe("A");
  });

  it("名前が合う署名が無く .minisig が複数なら、どれも使わない", async () => {
    const p = await pickLocalPackage([file("a.zip"), file("b.zip.minisig"), file("c.zip.minisig")]);
    expect(p?.signature).toBeUndefined();
  });

  it("zip が無ければ null", async () => {
    expect(await pickLocalPackage([file("a.zip.minisig")])).toBeNull();
  });
});

describe("ローカル zip の送信", () => {
  const capture = () => {
    vi.stubGlobal("window", {}); // apiBase() が window を読む（テストは node 環境）
    const forms: FormData[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      forms.push(init.body as FormData);
      return new Response("{}", { status: 200 });
    }));
    return forms;
  };

  it("署名を添えると signature / publicKey も送る", async () => {
    const forms = capture();
    const pkg = { zip: file("a.zip"), signature: "SIG", publicKey: "PUB" };
    await inspectPluginFromFile(pkg);
    await installPluginFromFile(pkg, "sha");
    for (const f of forms) {
      expect(f.get("signature")).toBe("SIG");
      expect(f.get("publicKey")).toBe("PUB");
    }
    expect(forms[1].get("confirmedSha256")).toBe("sha");
  });

  it("署名が無ければ送らない", async () => {
    const forms = capture();
    await inspectPluginFromFile({ zip: file("a.zip") });
    expect(forms[0].has("signature")).toBe(false);
    expect(forms[0].has("publicKey")).toBe(false);
  });
});

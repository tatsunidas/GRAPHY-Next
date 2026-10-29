/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  SPEC_MAX_BYTES,
  applySpecToForm,
  buildSpec,
  canonicalContentJson,
  contentSha256,
  defaultSpecContent,
  normalizeLabels,
  parseLabelInput,
  parseSpec,
  sha256Hex,
  specContentFrom,
  specText,
  type SpecContent,
} from "./batchSpec";
import { ROI_FEATURE_FAMILIES, defaultRoiFeatureForm } from "./roiFeatureSettings";

const content = (over: Partial<SpecContent> = {}): SpecContent => ({ ...defaultSpecContent(), ...over });

/** 検証を通る定義のテキストを作り、1 か所だけ書き換えたものを返す（SHA-256 は書き換え前のまま）。 */
async function text(mutate: (o: Record<string, any>) => void = () => undefined, c: SpecContent = content()): Promise<string> {
  const o = JSON.parse(specText(await buildSpec(c, "p")));
  mutate(o);
  return JSON.stringify(o);
}

describe("sha256", () => {
  it("matches the known SHA-256 of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("small-ROI threshold in the definition", () => {
  // 基準値を足す前に取った値（コミット前のコードで計算して固定）。基準値の無い従来の定義の SHA-256 は変わらない
  const BASE_DEFAULT = "9e08bec6fc61105a4113e5ea626ac8640c405c1b7ec31343b0b928419e43dced";
  const BASE_STOP_LABELS = "673da998ba6bff623ef058121cffeb17a9175bb45d7b01efa4309e9246ac636f";
  const withVoxels = (n: number | null): SpecContent => content({ qc: { smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: n } });

  it("a definition without a threshold keeps the SHA-256 it had before the field existed", async () => {
    expect(await contentSha256(defaultSpecContent())).toBe(BASE_DEFAULT);
    expect(await contentSha256(content({ qc: { smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: null }, selection: { segmentLabels: ["GTV", "tumor"] } }))).toBe(BASE_STOP_LABELS);
  });
  it("null leaves the key out of the canonical JSON and the saved file; a value writes it", async () => {
    expect(canonicalContentJson(withVoxels(null))).not.toContain("smallRoiVoxels");
    expect(specText(await buildSpec(withVoxels(null), "p"))).not.toContain("smallRoiVoxels");
    expect(canonicalContentJson(withVoxels(1000))).toContain('"smallRoiVoxels":1000');
    expect(specText(await buildSpec(withVoxels(1000), "p"))).toContain('"smallRoiVoxels": 1000');
  });
  it("a threshold changes the hash, and a different one changes it again", async () => {
    const none = await contentSha256(withVoxels(null));
    const a = await contentSha256(withVoxels(1000));
    const b = await contentSha256(withVoxels(1001));
    expect(new Set([none, a, b]).size).toBe(3);
  });
  it("round trip restores the value and the SHA-256", async () => {
    const spec = await buildSpec(withVoxels(1000), "p");
    const back = await parseSpec(specText(spec));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.spec.qc.smallRoiVoxels).toBe(1000);
    expect(back.spec.sha256).toBe(spec.sha256);
    const none = await parseSpec(specText(await buildSpec(withVoxels(null), "p")));
    expect(none.ok && none.spec.qc.smallRoiVoxels).toBeNull();
  });
  it("an explicit null in the file reads as no threshold (same hash as the file without the key)", async () => {
    const r = await parseSpec(await text((o) => { o.qc.smallRoiVoxels = null; }));
    expect(r.ok).toBe(true);
  });
  it("refuses a threshold that is not an integer from 1 to 2147483647 (negative cases)", async () => {
    const c = withVoxels(1000);
    const refuse = async (v: unknown, error: string) => {
      const r = await parseSpec(await text((o) => { o.qc.smallRoiVoxels = v; }, c));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe(error);
    };
    for (const v of [0, -1, 1.5, 2147483648]) await refuse(v, "range");
    for (const v of ["1000", true, [], {}]) await refuse(v, "type");
    const edge = await parseSpec(await text(() => undefined, withVoxels(2147483647)));
    expect(edge.ok).toBe(true);
  });
  it("tampering with the threshold is caught by the hash", async () => {
    const r = await parseSpec(await text((o) => { o.qc.smallRoiVoxels = 999; }, withVoxels(1000)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("sha_mismatch");
  });
});

describe("round trip", () => {
  it("save then load gives the same content and the same SHA-256", async () => {
    const c = content({
      form: { ...defaultSpecContent().form, fixedBinNumber: false, binWidth: 12.5, resampleMm: 1.5, families: { ...defaultSpecContent().form.families, GLAM: true } },
      qc: { smallRoi: "STOP", lossy: "STOP", smallRoiVoxels: null },
      selection: { segmentLabels: ["GTV", "tumor"] },
    });
    const spec = await buildSpec(c, "lung-ct");
    const back = await parseSpec(specText(spec));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.spec.sha256).toBe(spec.sha256);
    expect(back.spec.form).toEqual(spec.form);
    expect(back.spec.qc).toEqual({ smallRoi: "STOP", lossy: "STOP", smallRoiVoxels: null });
    expect(back.spec.selection.segmentLabels).toEqual(["GTV", "tumor"]);
    expect(back.spec.output.prefix).toBe("lung-ct");
    expect(back.ignoredFamilies).toBe(0);
  });

  it("the prefix is not a setting: renaming it does not change the hash", async () => {
    const a = await buildSpec(content(), "one");
    const b = await buildSpec(content(), "two");
    expect(a.sha256).toBe(b.sha256);
  });

  it("changing any setting changes the hash", async () => {
    const base = await contentSha256(content());
    const form = defaultSpecContent().form;
    expect(await contentSha256(content({ form: { ...form, binCount: 33 } }))).not.toBe(base);
    expect(await contentSha256(content({ form: { ...form, families: { ...form.families, GLCM: !form.families.GLCM } } }))).not.toBe(base);
    expect(await contentSha256(content({ qc: { smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: null } }))).not.toBe(base);
    expect(await contentSha256(content({ selection: { segmentLabels: ["GTV"] } }))).not.toBe(base);
  });

  it("the canonical JSON has a fixed key order (families follow the family list)", () => {
    const json = canonicalContentJson(content());
    const keys = ROI_FEATURE_FAMILIES.map((f) => `"${f.key}"`);
    const positions = keys.map((k) => json.indexOf(k));
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    expect(positions.every((p) => p > 0)).toBe(true);
  });

  it("the form round-trips through the input fields", () => {
    const base = defaultRoiFeatureForm();
    const c = specContentFrom({ ...base, binCount: 16, resampleMm: 2 }, { smallRoi: "FLAG", lossy: "STOP", smallRoiVoxels: null }, ["a", " a ", ""]);
    expect(c.selection.segmentLabels).toEqual(["a"]);
    const next = applySpecToForm({ ...base, logOn: true }, c);
    expect(next.binCount).toBe(16);
    expect(next.resampleMm).toBe(2);
    expect(next.logOn).toBe(true); // 定義に無い欄はそのまま
  });
});

describe("labels", () => {
  it("normalises: trim, drop empties and exact duplicates, keep order", () => {
    expect(normalizeLabels([" GTV", "gtv", "GTV ", "", "  "])).toEqual(["GTV", "gtv"]);
  });
  it("parses the input field on commas, 、 and newlines", () => {
    expect(parseLabelInput("GTV, tumor、liver\nkidney")).toEqual(["GTV", "tumor", "liver", "kidney"]);
    expect(parseLabelInput("")).toEqual([]);
  });
});

describe("parseSpec refuses what it should (negative cases)", () => {
  const refused = async (t: string, error: string) => {
    const r = await parseSpec(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(error);
  };

  it("a tampered body (hash no longer matches)", async () => {
    await refused(await text((o) => { o.form.binCount = 64; }), "sha_mismatch");
    await refused(await text((o) => { o.qc.smallRoi = "STOP"; }), "sha_mismatch");
    await refused(await text((o) => { o.selection.segmentLabels.push("x"); }), "sha_mismatch");
  });
  it("a missing or empty hash", async () => {
    await refused(await text((o) => { delete o.sha256; }), "sha_missing");
    await refused(await text((o) => { o.sha256 = ""; }), "sha_missing");
  });
  it("another format or version", async () => {
    await refused(await text((o) => { o.format = "other"; }), "format");
    await refused(await text((o) => { o.version = 2; }), "version");
  });
  it("not JSON / not an object", async () => {
    await refused("{ nope", "not_json");
    await refused("[1,2]", "not_object");
    await refused("null", "not_object");
  });
  it("wrong types", async () => {
    await refused(await text((o) => { o.form.fixedBinNumber = "yes"; }), "type");
    await refused(await text((o) => { o.qc.lossy = "MAYBE"; }), "type");
    await refused(await text((o) => { o.selection.segmentLabels = "GTV"; }), "type");
    await refused(await text((o) => { o.selection.segmentLabels = [1]; }), "type");
    await refused(await text((o) => { o.form.families.GLCM = 1; }), "type");
    await refused(await text((o) => { o.output = null; }), "type");
  });
  it("out-of-range values (same bounds as the input fields)", async () => {
    await refused(await text((o) => { o.form.binCount = 1; }), "range");
    await refused(await text((o) => { o.form.binCount = 2000; }), "range");
    await refused(await text((o) => { o.form.binCount = 32.5; }), "range");
    await refused(await text((o) => { o.form.binWidth = 0; }), "range");
    await refused(await text((o) => { o.form.resampleMm = 0.01; }), "range");
    await refused(await text((o) => { o.form.resampleMm = 21; }), "range");
    await refused(await text((o) => { o.selection.segmentLabels = Array(101).fill("a"); }), "range");
    await refused(await text((o) => { o.selection.segmentLabels = ["x".repeat(129)]; }), "range");
    await refused(await text((o) => { o.output.prefix = "p".repeat(101); }), "range");
  });
  it("a file over the size limit", async () => {
    await refused(`{"pad":"${"x".repeat(SPEC_MAX_BYTES)}"}`, "too_large");
  });
});

describe("parseSpec hardening", () => {
  it("unknown family keys are ignored and counted; missing ones take the default", async () => {
    const c = content();
    const spec = JSON.parse(specText(await buildSpec(c, "p")));
    spec.form.families.NotAFamily = true;
    delete spec.form.families.Fractal;
    const r = await parseSpec(JSON.stringify(spec));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ignoredFamilies).toBe(1);
    expect(r.spec.form.families.Fractal).toBe(defaultRoiFeatureForm().families.Fractal);
    expect(Object.keys(r.spec.form.families)).toEqual(ROI_FEATURE_FAMILIES.map((f) => f.key));
  });

  it("__proto__ / constructor keys do not pollute any prototype", async () => {
    const c = content();
    const body = specText(await buildSpec(c, "p")).replace(
      '"families": {', '"families": {\n      "__proto__": {"polluted": true},\n      "constructor": {"prototype": {"polluted": true}},');
    const r = await parseSpec(body);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    if (r.ok) {
      expect(r.ignoredFamilies).toBe(2);
      expect(Object.keys(r.spec.form.families)).not.toContain("__proto__");
    }
  });

  it("upper-case hex is accepted (compared case-insensitively)", async () => {
    const spec = JSON.parse(specText(await buildSpec(content(), "p")));
    spec.sha256 = String(spec.sha256).toUpperCase();
    expect((await parseSpec(JSON.stringify(spec))).ok).toBe(true);
  });
});

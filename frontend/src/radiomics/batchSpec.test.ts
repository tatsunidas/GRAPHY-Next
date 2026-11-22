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
import { ROI_FEATURE_FAMILIES, defaultRoiFeatureForm, type Unit2d } from "./roiFeatureSettings";

const content = (over: Partial<SpecContent> = {}): SpecContent => ({ ...defaultSpecContent(), ...over });

/**
 * 校正と値の種類の項目が無い従来の定義の内容（`calibration: null`・`valueKind: "legacy"`・リサンプリングなし。正準 JSON にキーを出さず、
 * SHA-256 は項目が増える前のまま）。新しい既定はリサンプリング 1 mm なので、従来の定義の再現には `resampleMm: null` が要る。
 */
const legacy = (c: SpecContent = defaultSpecContent()): SpecContent => ({ ...c, form: { ...c.form, calibration: null, valueKind: "legacy", resampleMm: null } });

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
  const withVoxels = (n: number | null): SpecContent => content({ qc: { smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: n, smallRoiPixels: null } });

  it("a definition without a threshold keeps the SHA-256 it had before the field existed", async () => {
    expect(await contentSha256(legacy())).toBe(BASE_DEFAULT);
    expect(await contentSha256(legacy(content({ qc: { smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: null, smallRoiPixels: null }, selection: { segmentLabels: ["GTV", "tumor"] } })))).toBe(BASE_STOP_LABELS);
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

describe("range in the definition", () => {
  const withRange = (min: number | null, max: number | null): SpecContent =>
    content({ form: { ...defaultSpecContent().form, rangeMin: min, rangeMax: max } });

  it("no range leaves the key out of the canonical JSON and the saved file", async () => {
    expect(canonicalContentJson(withRange(null, null))).not.toContain("range");
    expect(specText(await buildSpec(withRange(null, null), "p"))).not.toContain("range");
  });
  it("a range writes only the sides that are set", async () => {
    expect(canonicalContentJson(withRange(-850.5, null))).toContain('"rangeMin":-850.5');
    expect(canonicalContentJson(withRange(-850.5, null))).not.toContain("rangeMax");
    expect(canonicalContentJson(withRange(null, 300))).toContain('"rangeMax":300');
    expect(specText(await buildSpec(withRange(-850.5, 300), "p"))).toMatch(/"rangeMin": -850\.5[\s\S]*"rangeMax": 300/);
  });
  it("a range changes the hash, and each side and value changes it again", async () => {
    const hashes = await Promise.all([withRange(null, null), withRange(-850, null), withRange(null, -850), withRange(-850, 300), withRange(-851, 300)].map(contentSha256));
    expect(new Set(hashes).size).toBe(5);
  });
  it("round trip restores both sides, one side, and none", async () => {
    for (const [min, max] of [[-850.5, 300], [-850.5, null], [null, 300], [null, null]] as const) {
      const spec = await buildSpec(withRange(min, max), "p");
      const back = await parseSpec(specText(spec));
      expect(back.ok).toBe(true);
      if (!back.ok) continue;
      expect([back.spec.form.rangeMin, back.spec.form.rangeMax]).toEqual([min, max]);
      expect(back.spec.sha256).toBe(spec.sha256);
    }
  });
  it("an explicit null in the file reads as no bound (same hash as the file without the key)", async () => {
    const r = await parseSpec(await text((o) => { o.form.rangeMin = null; o.form.rangeMax = null; }));
    expect(r.ok).toBe(true);
  });
  it("refuses a non-number bound and a lower bound above the upper bound (negative cases)", async () => {
    const c = withRange(-850, 300);
    const refuse = async (mutate: (o: Record<string, any>) => void, error: string) => {
      const r = await parseSpec(await text(mutate, c));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe(error);
    };
    for (const v of ["-850", true, [], {}]) await refuse((o) => { o.form.rangeMin = v; }, "type");
    await refuse((o) => { o.form.rangeMax = "300"; }, "type");
    await refuse((o) => { o.form.rangeMin = 400; }, "range");
    expect((await parseSpec(await text(() => undefined, withRange(300, 300)))).ok).toBe(true);
  });
  it("tampering with a bound is caught by the hash", async () => {
    const r = await parseSpec(await text((o) => { o.form.rangeMin = -800; }, withRange(-850, 300)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("sha_mismatch");
  });
  it("the form fields round-trip as text; an empty side is an empty field", () => {
    const base = defaultRoiFeatureForm();
    const c = specContentFrom({ ...base, rangeMinText: " -850.5 ", rangeMaxText: "" }, defaultSpecContent().qc, []);
    expect([c.form.rangeMin, c.form.rangeMax]).toEqual([-850.5, null]);
    const back = applySpecToForm({ ...base, rangeMinText: "9", rangeMaxText: "9" }, c);
    expect([back.rangeMinText, back.rangeMaxText]).toEqual(["-850.5", ""]);
    expect(Object.keys(back)).not.toContain("rangeMin");
  });
  it("a reversed or non-numeric field gives no range (the dialog stops before this matters)", () => {
    const base = defaultRoiFeatureForm();
    for (const [lo, hi] of [["5", "1"], ["abc", ""]]) {
      const c = specContentFrom({ ...base, rangeMinText: lo, rangeMaxText: hi }, defaultSpecContent().qc, []);
      expect([c.form.rangeMin, c.form.rangeMax]).toEqual([null, null]);
    }
  });
});

describe("round trip", () => {
  it("save then load gives the same content and the same SHA-256", async () => {
    const c = content({
      form: { ...defaultSpecContent().form, fixedBinNumber: false, binWidth: 12.5, resampleMm: 1.5, families: { ...defaultSpecContent().form.families, GLAM: true } },
      qc: { smallRoi: "STOP", lossy: "STOP", smallRoiVoxels: null, smallRoiPixels: null },
      selection: { segmentLabels: ["GTV", "tumor"] },
    });
    const spec = await buildSpec(c, "lung-ct");
    const back = await parseSpec(specText(spec));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.spec.sha256).toBe(spec.sha256);
    expect(back.spec.form).toEqual(spec.form);
    expect(back.spec.qc).toEqual({ smallRoi: "STOP", lossy: "STOP", smallRoiVoxels: null, smallRoiPixels: null });
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
    expect(await contentSha256(content({ qc: { smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: null, smallRoiPixels: null } }))).not.toBe(base);
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
    const c = specContentFrom({ ...base, binCount: 16, resampleMm: 2 }, { smallRoi: "FLAG", lossy: "STOP", smallRoiVoxels: null, smallRoiPixels: null }, ["a", " a ", ""]);
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

describe("kind in the definition", () => {
  const voi = (over: Partial<SpecContent> = {}): SpecContent => content({ kind: "voiStats", ...over });

  it("a definition without a kind keeps the SHA-256 it had before the field existed", async () => {
    // 種類を足す前に取った固定値（上の「基準値」の節と同じ値）。radiomics のときはキーを出さない
    expect(await contentSha256(legacy())).toBe("9e08bec6fc61105a4113e5ea626ac8640c405c1b7ec31343b0b928419e43dced");
    expect(canonicalContentJson(legacy())).not.toContain("kind");
    expect(specText(await buildSpec(legacy(), "p"))).not.toContain("kind");
  });

  it("the kind changes the SHA-256, and is written to the file only when it is voiStats", async () => {
    const a = await contentSha256(defaultSpecContent());
    const b = await contentSha256(voi());
    expect(b).not.toBe(a);
    expect(canonicalContentJson(voi())).toContain('"kind":"voiStats"');
    expect(JSON.parse(specText(await buildSpec(voi(), "p"))).kind).toBe("voiStats");
  });

  it("hidden feature settings do not change the SHA-256 of a voiStats definition", async () => {
    const f = defaultSpecContent().form;
    const other = voi({ form: { ...f, binCount: 64, resampleMm: 2, rangeMin: -100, families: { ...f.families, GLCM: false } } });
    expect(await contentSha256(other)).toBe(await contentSha256(voi()));
    // radiomics では同じ変更でハッシュが変わる（上の固定が空振りでないことの対照）
    const rad = content({ form: { ...f, binCount: 64 } });
    expect(await contentSha256(rad)).not.toBe(await contentSha256(defaultSpecContent()));
  });

  it("round-trips through save and load", async () => {
    const r = await parseSpec(specText(await buildSpec(voi({ qc: { smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: 50, smallRoiPixels: null } }), "x")));
    expect(r.ok && r.spec.kind).toBe("voiStats");
    expect(r.ok && r.spec.qc.smallRoiVoxels).toBe(50);
    expect(r.ok && r.spec.sha256).toBe(await contentSha256(voi({ qc: { smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: 50, smallRoiPixels: null } })));
  });

  it("accepts an explicit radiomics or null kind (same SHA-256), rejects anything else", async () => {
    for (const k of ["radiomics", null]) {
      const r = await parseSpec(await text((o) => { o.kind = k; }));
      expect(r.ok && r.spec.kind, String(k)).toBe("radiomics");
    }
    for (const k of ["dynamic", 5, ["voiStats"], true, {}]) {
      const r = await parseSpec(await text((o) => { o.kind = k; }));
      expect(r.ok ? "ok" : r.error, JSON.stringify(k)).toBe("type");
    }
  });

  it("rejects a kind edited after saving (the hash no longer matches)", async () => {
    const r = await parseSpec(await text((o) => { o.kind = "voiStats"; }));
    expect(r.ok ? "ok" : r.error).toBe("sha_mismatch");
  });

  it("specContentFrom carries the kind and loading a voiStats file sets it back", async () => {
    const base = defaultRoiFeatureForm();
    expect(specContentFrom(base, defaultSpecContent().qc, [], "voiStats").kind).toBe("voiStats");
    expect(specContentFrom(base, defaultSpecContent().qc, []).kind).toBe("radiomics");
  });
});


describe("value kind (IVH mode and rounding) in the definition", () => {
  // 正準 JSON のキーを足し引きして、別（Python の hashlib）で求めた値
  const LEGACY_SHA = "9e08bec6fc61105a4113e5ea626ac8640c405c1b7ec31343b0b928419e43dced"; // 校正も値の種類も無い
  const CAL_ONLY_SHA = "f54302dd56d8504990b9668e2ce2a2724c71476b4e7ebbf31e76eb1b5f1af659"; // 校正（auto）だけ
  const PRB_DEFAULT_SHA = "78f5a3d4001797d079252e55cd8ff3cbcce5f2707273eade0ac5d82076994ac2"; // 校正（auto）＋値の種類（auto）、リサンプリングなし
  const NEW_DEFAULT_SHA = "f0f8273683f4304a247ca1ccad7d54687be5fa5ab313c4ce2613feb1776de81c"; // 同＋リサンプリング等方 1 mm（新しい既定）

  it("the new default definition has the SHA-256 computed independently", async () => {
    expect(await contentSha256(defaultSpecContent())).toBe(NEW_DEFAULT_SHA);
    expect(canonicalContentJson(defaultSpecContent())).toContain('"resampleMm":1,');
    expect(canonicalContentJson(defaultSpecContent())).toContain('"calibration":"auto","valueKind":"auto"}');
  });

  it("the same definition with no resampling keeps the SHA-256 it had before the default became 1 mm", async () => {
    const c = defaultSpecContent();
    expect(await contentSha256({ ...c, form: { ...c.form, resampleMm: null } })).toBe(PRB_DEFAULT_SHA);
  });

  it("a definition with the calibration but no value kind keeps its SHA-256 and means 'legacy'", async () => {
    const c = defaultSpecContent();
    const calOnly: SpecContent = { ...c, form: { ...c.form, valueKind: "legacy", resampleMm: null } };
    expect(await contentSha256(calOnly)).toBe(CAL_ONLY_SHA);
    const r = await parseSpec(specText(await buildSpec(calOnly, "p")));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.sha256).toBe(CAL_ONLY_SHA);
    expect(r.spec.form.valueKind).toBe("legacy");
    expect(applySpecToForm(defaultRoiFeatureForm(), r.spec).valueKind).toBe("legacy");
  });

  it("a legacy definition (no calibration, no value kind) keeps its SHA-256", async () => {
    expect(await contentSha256(legacy())).toBe(LEGACY_SHA);
  });

  it("every choice, the bin width and the rounding change the hash and survive save and load", async () => {
    const base = defaultSpecContent().form;
    const variants = [
      { ...base, valueKind: "discrete" as const },
      { ...base, valueKind: "continuous" as const, ivhBinWidth: 0.1 },
      { ...base, valueKind: "continuous" as const, ivhBinWidth: 0.2 },
      { ...base, valueKind: "arbitrary" as const },
      { ...base, valueKind: "discrete" as const, intensityRounding: true },
      { ...base, valueKind: "legacy" as const },
    ];
    const seen = new Set<string>([NEW_DEFAULT_SHA]);
    for (const form of variants) {
      const c = content({ form });
      const sha = await contentSha256(c);
      expect(seen.has(sha)).toBe(false);
      seen.add(sha);
      const r = await parseSpec(specText(await buildSpec(c, "p")));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.spec.form.valueKind).toBe(form.valueKind);
        expect(r.spec.form.ivhBinWidth).toBe(form.ivhBinWidth);
        expect(r.spec.form.intensityRounding).toBe(form.intensityRounding);
      }
    }
  });

  it("a VOI statistics definition keeps its SHA-256 (computed independently) although the default resampling became 1 mm", async () => {
    // 正準 JSON は、校正だけがあった頃の既定（リサンプリングなし）に "kind":"voiStats" を足したもの。別（Python の hashlib）で求めた値
    const VOI_DEFAULT_SHA = "b7d3d50f479d3e27a3458ecde190c1e251c283f78aa1755e5fff5066a775b521";
    const voi = (form: SpecContent["form"]): SpecContent => content({ kind: "voiStats", form });
    expect(await contentSha256(voi(defaultSpecContent().form))).toBe(VOI_DEFAULT_SHA);
    expect(await contentSha256(voi({ ...defaultSpecContent().form, resampleMm: null }))).toBe(VOI_DEFAULT_SHA);
    expect(JSON.parse(specText(await buildSpec(voi(defaultSpecContent().form), "p"))).form.resampleMm).toBeNull();
    const r = await parseSpec(specText(await buildSpec(voi(defaultSpecContent().form), "p")));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.sha256).toBe(VOI_DEFAULT_SHA);
  });

  it("the VOI statistics do not use the value kind (their SHA-256 does not change with it)", async () => {
    const a = await contentSha256(content({ kind: "voiStats", form: { ...defaultSpecContent().form, valueKind: "auto" } }));
    const b = await contentSha256(content({ kind: "voiStats", form: { ...defaultSpecContent().form, valueKind: "discrete", intensityRounding: true } }));
    expect(a).toBe(b);
  });

  it("an unknown value kind, a bad bin width and a bad rounding are refused (negative)", async () => {
    for (const [mut, detail] of [
      [(o: any) => { o.form.valueKind = "magic"; }, "form.valueKind"],
      [(o: any) => { o.form.ivhBinWidth = "0.1"; }, "form.ivhBinWidth"],
      [(o: any) => { o.form.ivhBinWidth = -1; }, "form.ivhBinWidth"],
      [(o: any) => { o.form.intensityRounding = "yes"; }, "form.intensityRounding"],
    ] as const) {
      const r = await parseSpec(await text(mut));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.detail).toBe(detail);
    }
  });

  it("a rewritten value kind is refused by the SHA-256 (negative)", async () => {
    const r = await parseSpec(await text((o) => { o.form.valueKind = "discrete"; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("sha_mismatch");
  });

  it("the form's value kind, bin width and rounding go into the definition and back", () => {
    const form = { ...defaultRoiFeatureForm(), valueKind: "continuous" as const, ivhBinWidthText: "0.25", intensityRounding: true };
    const c = specContentFrom(form, defaultSpecContent().qc, []);
    expect(c.form.valueKind).toBe("continuous");
    expect(c.form.ivhBinWidth).toBe(0.25);
    expect(c.form.intensityRounding).toBe(true);
    const back = applySpecToForm(defaultRoiFeatureForm(), c);
    expect(back.valueKind).toBe("continuous");
    expect(back.ivhBinWidthText).toBe("0.25");
    expect(back.intensityRounding).toBe(true);
  });
});

describe("calibration (PET) in the definition", () => {
  const LEGACY_SHA = "9e08bec6fc61105a4113e5ea626ac8640c405c1b7ec31343b0b928419e43dced";

  it("a new definition writes the calibration (default auto) and its SHA-256 differs from a legacy definition", async () => {
    const c = defaultSpecContent();
    expect(c.form.calibration).toBe("auto");
    expect(canonicalContentJson(c)).toContain('"calibration":"auto"');
    expect(await contentSha256(c)).not.toBe(LEGACY_SHA);
    expect(JSON.parse(specText(await buildSpec(c, "p"))).form.calibration).toBe("auto");
  });

  it("every choice changes the hash, and survives save and load", async () => {
    const seen = new Set<string>();
    for (const cal of ["auto", "bw", "sul-james", "sul-janma", "bsa", "none"] as const) {
      const c = content({ form: { ...defaultSpecContent().form, calibration: cal } });
      const sha = await contentSha256(c);
      expect(seen.has(sha)).toBe(false);
      seen.add(sha);
      const r = await parseSpec(specText(await buildSpec(c, "p")));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.spec.form.calibration).toBe(cal);
    }
  });

  it("a legacy definition (no calibration item) still loads with its old SHA-256 and means 'no calibration'", async () => {
    const t = specText(await buildSpec(legacy(), "p"));
    expect(JSON.parse(t).form.calibration).toBeUndefined();
    const r = await parseSpec(t);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.sha256).toBe(LEGACY_SHA);
    expect(r.spec.form.calibration).toBeNull();
    // 従来の結果を再現するため、PET は校正しない
    expect(applySpecToForm(defaultRoiFeatureForm(), r.spec).calibration).toBe("none");
  });

  it("an unknown calibration value is refused and nothing is loaded (negative)", async () => {
    const t = await text((o) => { o.form.calibration = "suv-magic"; });
    const r = await parseSpec(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toBe("form.calibration");
  });

  it("a rewritten calibration is refused by the SHA-256 (negative)", async () => {
    const t = await text((o) => { o.form.calibration = "none"; });
    const r = await parseSpec(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("sha_mismatch");
  });

  it("the VOI statistics keep the calibration (it is not reset to the default with the hidden fields)", async () => {
    const a = await contentSha256(content({ kind: "voiStats", form: { ...defaultSpecContent().form, calibration: "bw" } }));
    const b = await contentSha256(content({ kind: "voiStats", form: { ...defaultSpecContent().form, calibration: "sul-james" } }));
    expect(a).not.toBe(b);
  });

  it("the form's calibration goes into the definition and back", () => {
    const form = { ...defaultRoiFeatureForm(), calibration: "sul-janma" as const };
    const c = specContentFrom(form, defaultSpecContent().qc, []);
    expect(c.form.calibration).toBe("sul-janma");
    expect(applySpecToForm(defaultRoiFeatureForm(), c).calibration).toBe("sul-janma");
  });
});

describe("detail settings and the QC skip mode in the definition", () => {
  // 正準 JSON を文字列として組み立てて、別（Python の hashlib）で求めた値
  const WITH_SETTINGS_SHA = "deb769a3fb56c381fd62f558bc122ae44c83ef50c023f8d63b5a3e8349e5e5fe"; // 新しい既定 + settings {DOUBLE_zScore: "2.5", INT_deltaGLCM: "2"}
  const SKIP_SHA = "9e1e4da2633934a48cc0a12f7ffc9d55eedb1df85c8a690b70443eb268a874a8"; // 新しい既定 + qc {smallRoi: SKIP, lossy: STOP}
  const DEFAULT_SHA = "f0f8273683f4304a247ca1ccad7d54687be5fa5ab313c4ce2613feb1776de81c";

  it("an empty settings leaves the SHA-256 as it was; a non-empty one changes it to the independent value, whatever the insertion order", async () => {
    const f = defaultSpecContent().form;
    expect(await contentSha256(content({ form: { ...f, settings: {} } }))).toBe(DEFAULT_SHA);
    expect(await contentSha256(content({ form: { ...f, settings: { INT_deltaGLCM: "2", DOUBLE_zScore: "2.5" } } }))).toBe(WITH_SETTINGS_SHA);
    expect(await contentSha256(content({ form: { ...f, settings: { DOUBLE_zScore: "2.5", INT_deltaGLCM: "2" } } }))).toBe(WITH_SETTINGS_SHA);
    expect(canonicalContentJson(content({ form: { ...f, settings: { INT_deltaGLCM: "2", DOUBLE_zScore: "2.5" } } })))
      .toContain('"settings":{"DOUBLE_zScore":"2.5","INT_deltaGLCM":"2"}');
  });

  it("settings survive save and load, and reach the form text", async () => {
    const c = content({ form: { ...defaultSpecContent().form, settings: { INT_deltaGLCM: "2" } } });
    const r = await parseSpec(specText(await buildSpec(c, "p")));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.form.settings).toEqual({ INT_deltaGLCM: "2" });
    expect(applySpecToForm(defaultRoiFeatureForm(), r.spec).advancedText).toBe("INT_deltaGLCM=2");
    const back = specContentFrom({ ...defaultRoiFeatureForm(), advancedText: "# a note\nINT_deltaGLCM = 2\nINT_binCount=5" }, defaultSpecContent().qc, []);
    expect(back.form.settings).toEqual({ INT_deltaGLCM: "2" }); // 他の欄のキーは入らない
  });

  it("VOI statistics ignore the settings", async () => {
    const f = defaultSpecContent().form;
    const a = await contentSha256(content({ kind: "voiStats", form: { ...f, settings: { INT_deltaGLCM: "2" } } }));
    const b = await contentSha256(content({ kind: "voiStats", form: f }));
    expect(a).toBe(b);
  });

  it("bad settings are refused (negative): not an object, a non-string value, an empty value, a bad key, too many", async () => {
    for (const bad of [[1, 2], { INT_deltaGLCM: 2 }, { INT_deltaGLCM: "" }, { "bad key": "1" }, { "1abc": "1" },
      Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`INT_k${i}`, "1"]))]) {
      const r = await parseSpec(await text((o) => { o.form.settings = bad; }));
      expect(r.ok).toBe(false);
    }
  });

  it("a rewritten settings is refused by the SHA-256 (negative)", async () => {
    const c = content({ form: { ...defaultSpecContent().form, settings: { INT_deltaGLCM: "2" } } });
    const t = specText(await buildSpec(c, "p"));
    const o = JSON.parse(t);
    o.form.settings.INT_deltaGLCM = "3";
    const r = await parseSpec(JSON.stringify(o));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("sha_mismatch");
  });

  it("the QC skip mode is written as it is, has its own SHA-256 (independent), loads, and an unknown mode is refused", async () => {
    const q = { smallRoi: "SKIP" as const, lossy: "STOP" as const, smallRoiVoxels: null, smallRoiPixels: null };
    expect(await contentSha256(content({ qc: q }))).toBe(SKIP_SHA);
    const r = await parseSpec(specText(await buildSpec(content({ qc: q }), "p")));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.qc).toEqual(q);
    const bad = await parseSpec(await text((o) => { o.qc.smallRoi = "PAUSE"; }));
    expect(bad.ok).toBe(false);
    // 従来の STOP の定義は、そのまま読める（SHA も変わらない）
    expect(await contentSha256(legacy(content({ qc: { smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: null, smallRoiPixels: null }, selection: { segmentLabels: ["GTV", "tumor"] } })))).toBe("673da998ba6bff623ef058121cffeb17a9175bb45d7b01efa4309e9246ac636f");
  });
});

describe("2D の単位と断面（units・planes）", () => {
  // Python（hashlib・json）で、正準 JSON を独立に組み立てて求めた値
  const SEC_SHA = "3c0067c0710d305d0065ad13c6efb9d71a47ccef1358073e4e47bfc31b9a6e26";
  const BOTH_SHA = "863b37d9c3322c11498ec7b4dfb00085984d725beb7d9b80872a8f2285aca7e8";
  const BOTH_ALL_SHA = "b329095c279a3859218615b1ec7bdce4a630b010e79c277fef5ce3c2b114e42b";
  const withUnits = (units2d: Unit2d[], planesAll = false) => content({ form: { ...defaultSpecContent().form, units2d, planesAll } });

  it("3D だけの定義の SHA-256 は変わらない（キーを出さない）。新しい項目の SHA-256 は独立の計算と一致", async () => {
    expect(await contentSha256(defaultSpecContent())).toBe("f0f8273683f4304a247ca1ccad7d54687be5fa5ab313c4ce2613feb1776de81c");
    expect(await contentSha256(withUnits(["MAX_SECTION_2D"]))).toBe(SEC_SHA);
    expect(await contentSha256(withUnits(["MAX_SECTION_2D", "SLICES_2D"]))).toBe(BOTH_SHA);
    expect(await contentSha256(withUnits(["MAX_SECTION_2D", "SLICES_2D"], true))).toBe(BOTH_ALL_SHA);
  });

  it("単位の並びに依らず同じ SHA-256。2D の単位が無ければ断面は効かない（SHA-256 も同じ）", async () => {
    expect(await contentSha256(withUnits(["SLICES_2D", "MAX_SECTION_2D"]))).toBe(BOTH_SHA);
    expect(await contentSha256(withUnits([], true))).toBe(await contentSha256(defaultSpecContent()));
  });

  it("保存して読み直すと同じ。VOI 統計では 2D の単位を使わない（SHA-256 に影響しない）", async () => {
    const c = withUnits(["MAX_SECTION_2D", "SLICES_2D"], true);
    const r = await parseSpec(specText(await buildSpec(c, "p")));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.form.units2d).toEqual(["MAX_SECTION_2D", "SLICES_2D"]);
      expect(r.spec.form.planesAll).toBe(true);
      expect(applySpecToForm(defaultRoiFeatureForm(), r.spec).units2d).toEqual(["MAX_SECTION_2D", "SLICES_2D"]);
    }
    const voi = { ...withUnits(["SLICES_2D"], true), kind: "voiStats" as const };
    expect(await contentSha256(voi)).toBe(await contentSha256({ ...defaultSpecContent(), kind: "voiStats" }));
  });

  it("不正な単位・断面は理由つきで断る（何も変えない）", async () => {
    const c = withUnits(["MAX_SECTION_2D"]);
    const bad = async (mutate: (o: Record<string, any>) => void) => parseSpec(await text(mutate, c));
    expect(await bad((o) => { o.form.units = ["WHOLE_3D"]; })).toMatchObject({ ok: false, error: "type" });
    expect(await bad((o) => { o.form.units = []; })).toMatchObject({ ok: false, error: "type" });
    expect(await bad((o) => { o.form.units = ["SLICES_2D", "SLICES_2D"]; })).toMatchObject({ ok: false, error: "type" });
    expect(await bad((o) => { o.form.planes = "SIDEWAYS"; })).toMatchObject({ ok: false, error: "type" });
    expect(await bad((o) => { delete o.form.units; o.form.planes = "ALL"; })).toMatchObject({ ok: false, error: "type" });
  });
});

describe("2D の小さい ROI の基準値（qc.smallRoiPixels）", () => {
  // Python（hashlib・json）で、正準 JSON を独立に組み立てて求めた値
  const PX150_SHA = "c8acc416e7a0f1dbb0bad85fe9c3cbffa672d9c56a07a96a1b0b340128480272";
  const BOTH_SHA = "4fa035371d437b7180f19125757ab3e2b5299c7c9283058ce0f4f1e2afb54d29";
  const withQc = (qc: SpecContent["qc"]) => content({ qc });

  it("無い定義の SHA-256 は変わらない。指定した値の SHA-256 は独立の計算と一致（ボクセルの基準値と併用も）", async () => {
    expect(await contentSha256(defaultSpecContent())).toBe("f0f8273683f4304a247ca1ccad7d54687be5fa5ab313c4ce2613feb1776de81c");
    expect(await contentSha256(withQc({ smallRoi: "FLAG", lossy: "FLAG", smallRoiVoxels: null, smallRoiPixels: 150 }))).toBe(PX150_SHA);
    expect(await contentSha256(withQc({ smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: 1000, smallRoiPixels: 150 }))).toBe(BOTH_SHA);
  });

  it("保存して読み直すと同じ。値が違えば SHA-256 も違う", async () => {
    const c = withQc({ smallRoi: "STOP", lossy: "FLAG", smallRoiVoxels: 1000, smallRoiPixels: 150 });
    const r = await parseSpec(specText(await buildSpec(c, "p")));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.qc.smallRoiPixels).toBe(150);
    expect(await contentSha256(withQc({ smallRoi: "FLAG", lossy: "FLAG", smallRoiVoxels: null, smallRoiPixels: 151 }))).not.toBe(PX150_SHA);
  });

  it("不正な値（0・小数・文字・大きすぎる）は理由つきで断る", async () => {
    const c = withQc({ smallRoi: "FLAG", lossy: "FLAG", smallRoiVoxels: null, smallRoiPixels: 150 });
    const bad = async (v: unknown) => parseSpec(await text((o) => { o.qc.smallRoiPixels = v; }, c));
    expect(await bad(0)).toMatchObject({ ok: false, error: "range" });
    expect(await bad(1.5)).toMatchObject({ ok: false, error: "range" });
    expect(await bad(2147483648)).toMatchObject({ ok: false, error: "range" });
    expect(await bad("150")).toMatchObject({ ok: false, error: "type" });
  });
});

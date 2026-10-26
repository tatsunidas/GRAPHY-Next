/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  contentFingerprint,
  countFrames,
  decodeFrames,
  encodeFrames,
  framesFingerprintInput,
  maskMetaSignature,
  maskSeriesUid,
  parseSavedMaskMeta,
  selectMasksToRestore,
  toSavedMaskMeta,
  type SavedMaskSummary,
} from "./maskPersistence";
import type { MaskFramesInput } from "./maskFrames";

const u8ToB64 = (u: Uint8Array): string => {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
};

/** 64×64 の面に、指定した画素だけ 1 を立てる。 */
const plane = (on: number[]): string => {
  const p = new Uint8Array(64 * 64);
  for (const i of on) p[i] = 1;
  return u8ToB64(p);
};

const input = (): MaskFramesInput => ({
  rows: 64,
  columns: 64,
  segments: [
    { number: 1, label: "ROI 1", color: [255, 0, 0], frames: [
      { referencedSopInstanceUid: "1.2.3.1", imagePositionPatient: [0, 0, 0], mask: plane([1, 2, 3, 100]) },
      { referencedSopInstanceUid: "1.2.3.2", imagePositionPatient: [0, 0, 5], mask: plane([7]) },
    ] },
    { number: 2, label: "ROI 2", color: null, description: "d", frames: [
      { referencedSopInstanceUid: "1.2.3.2", imagePositionPatient: [0, 0, 5], mask: plane([9, 10]) },
    ] },
  ],
});

describe("encodeFrames / decodeFrames", () => {
  it("往復でフレームの中身が 1 バイトも変わらない", async () => {
    const src = input();
    const back = await decodeFrames(await encodeFrames(src));
    expect(back).toEqual(src);
    expect(countFrames(back!)).toBe(3);
  });

  it("疎な面は大きく縮む（圧縮が効いている）", async () => {
    const big: MaskFramesInput = { rows: 512, columns: 512, segments: [{ number: 1, label: "x", color: null, frames:
      Array.from({ length: 20 }, (_, i) => ({ referencedSopInstanceUid: `s${i}`, imagePositionPatient: [0, 0, i] as [number, number, number], mask: u8ToB64((() => { const p = new Uint8Array(512 * 512); p.fill(1, 1000, 3000); return p; })()) })) }] };
    const raw = JSON.stringify(big).length;
    const enc = await encodeFrames(big);
    expect(enc.length).toBeLessThan(raw / 20);
    expect(await decodeFrames(enc)).toEqual(big);
  });

  it("壊れたバイト列・形の違う JSON は null（例外にしない）", async () => {
    expect(await decodeFrames(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(await decodeFrames(await encodeFrames({ rows: 1, columns: 1, segments: [{ number: 1, label: "", color: null, frames: [{ mask: 5 }] }] } as unknown as MaskFramesInput))).toBeNull();
    expect(await decodeFrames(await encodeFrames({ foo: 1 } as unknown as MaskFramesInput))).toBeNull();
  });
});

describe("toSavedMaskMeta", () => {
  const base = { patientKey: "P", label: "ROI 1", origin: { seriesUid: "S1", z: "all" as const }, scope: { seriesUid: "S1", z: "all" as const, c: 0, t: 0 } };
  it("患者かシリーズが分からないマスクは保存しない", () => {
    expect(toSavedMaskMeta(undefined)).toBeNull();
    expect(toSavedMaskMeta({ ...base, patientKey: "" })).toBeNull();
    expect(toSavedMaskMeta({ label: "x", patientKey: "P" })).toBeNull();
  });
  it("lastSegExport・persistUid は保存しない／グループ・セグメント名は保存する", () => {
    const out = toSavedMaskMeta({ ...base, groupId: "g", groupName: "G", segments: [1, 2], segmentLabels: { "1": "a" }, lastSegExport: { studyUid: "a", seriesUid: "b", sopInstanceUid: "c" }, persistUid: "u" } as never)!;
    expect(out).toMatchObject({ patientKey: "P", groupId: "g", groupName: "G", segments: [1, 2], segmentLabels: { "1": "a" } });
    expect(out).not.toHaveProperty("lastSegExport");
    expect(out).not.toHaveProperty("persistUid");
  });
  it("シリーズは原本（origin）を優先する", () => {
    expect(maskSeriesUid({ origin: { seriesUid: "O" }, scope: { seriesUid: "S" } })).toBe("O");
    expect(maskSeriesUid({ scope: { seriesUid: "S" } })).toBe("S");
    expect(maskSeriesUid({})).toBeUndefined();
  });
});

describe("maskMetaSignature", () => {
  it("キー順が違っても同じ、内容が違えば別", () => {
    const a = { patientKey: "P", label: "a", custom: { x: "1", y: "2" } };
    const b = { custom: { y: "2", x: "1" }, label: "a", patientKey: "P" };
    expect(maskMetaSignature(a)).toBe(maskMetaSignature(b));
    expect(maskMetaSignature({ ...a, label: "b" })).not.toBe(maskMetaSignature(a));
  });
});

describe("parseSavedMaskMeta", () => {
  it("往復し、壊れた項目だけを落とす", () => {
    const m = toSavedMaskMeta({ patientKey: "P", label: "ROI", origin: { seriesUid: "S", z: "all", c: 1 }, groupId: "g", groupName: "G", segments: [1], segmentLabels: { "1": "n" } })!;
    expect(parseSavedMaskMeta(JSON.stringify(m))).toEqual(m);
    const dirty = parseSavedMaskMeta(JSON.stringify({ patientKey: "P", label: 3, segments: [1, -2, "x", 2.5], custom: { a: 1, b: "ok" }, scope: { c: "NaN", t: 2 } }))!;
    expect(dirty).toEqual({ patientKey: "P", segments: [1], custom: { b: "ok" }, scope: { t: 2 } });
  });
  it("患者が無い・JSON でない・オブジェクトでないは null", () => {
    expect(parseSavedMaskMeta("{}")).toBeNull();
    expect(parseSavedMaskMeta("nope")).toBeNull();
    expect(parseSavedMaskMeta("[1]")).toBeNull();
    expect(parseSavedMaskMeta(null)).toBeNull();
  });
});

describe("selectMasksToRestore", () => {
  const sum = (maskUid: string, seriesUid: string, meta = '{"patientKey":"P"}'): SavedMaskSummary => ({ maskUid, seriesUid, meta, frameCount: 1, bytes: 10, version: 0, updatedAt: null });
  it("指定シリーズで、この窓にまだ無く、メタが読めるものだけ", () => {
    const out = selectMasksToRestore([sum("a", "S"), sum("b", "OTHER"), sum("c", "S"), sum("d", "S", "broken")], "S", new Set(["c"]));
    expect(out.map((o) => o.summary.maskUid)).toEqual(["a"]);
  });
});

describe("contentFingerprint", () => {
  const a = new Uint8Array([1, 2, 3, 4, 5]);
  it("同じ内容なら同じ、画素かメタが 1 つ違えば別", () => {
    expect(contentFingerprint("sig", a)).toBe(contentFingerprint("sig", new Uint8Array([1, 2, 3, 4, 5])));
    expect(contentFingerprint("sig", a)).not.toBe(contentFingerprint("sig", new Uint8Array([1, 2, 3, 4, 6])));
    expect(contentFingerprint("sig", a)).not.toBe(contentFingerprint("sig2", a));
    expect(contentFingerprint("sig", a)).not.toBe(contentFingerprint("sig", new Uint8Array([1, 2, 3, 4])));
  });
  it("並びだけが違う画素も区別する", () => {
    expect(contentFingerprint("s", new Uint8Array([1, 2]))).not.toBe(contentFingerprint("s", new Uint8Array([2, 1])));
  });
});

describe("framesFingerprintInput", () => {
  it("色・体積が違っても同じ（画素・名前・位置だけを見る）", () => {
    const a = input();
    const b = JSON.parse(JSON.stringify(a)) as MaskFramesInput;
    b.segments[0].color = null;
    b.segments[1].color = [1, 2, 3];
    b.volumeMm3 = 123;
    b.depthSource = "ipp";
    expect(framesFingerprintInput(a)).toEqual(framesFingerprintInput(b));
  });
  it("画素・名前・位置が違えば別", () => {
    const a = input();
    const px = JSON.parse(JSON.stringify(a)) as MaskFramesInput;
    px.segments[0].frames[0].mask = plane([1, 2, 3, 101]);
    const name = JSON.parse(JSON.stringify(a)) as MaskFramesInput;
    name.segments[0].label = "other";
    const pos = JSON.parse(JSON.stringify(a)) as MaskFramesInput;
    pos.segments[0].frames[0].referencedSopInstanceUid = "9.9";
    for (const v of [px, name, pos]) expect(framesFingerprintInput(v)).not.toEqual(framesFingerprintInput(a));
  });
});

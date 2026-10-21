import { describe, expect, it } from "vitest";
import { parseDicomDirBytes } from "./dicomdir";

/** Explicit VR LE の要素を 1 つ作る。 */
function el(group: number, elem: number, vr: string, value: string | number[], undefinedLength = false): number[] {
  const bytes = typeof value === "string" ? Array.from(new TextEncoder().encode(value)) : value;
  const pad = bytes.length % 2 === 1 && typeof value === "string" ? [0x20] : [];
  const body = [...bytes, ...pad];
  const head = [group & 0xff, group >> 8, elem & 0xff, elem >> 8, vr.charCodeAt(0), vr.charCodeAt(1)];
  if (vr === "SQ" || vr === "OB" || vr === "UN") {
    const len = undefinedLength ? [0xff, 0xff, 0xff, 0xff] : [body.length & 0xff, (body.length >> 8) & 0xff, (body.length >> 16) & 0xff, (body.length >> 24) & 0xff];
    return [...head, 0, 0, ...len, ...body];
  }
  return [...head, body.length & 0xff, body.length >> 8, ...body];
}

/** ディレクトリレコード 1 件（Item・定義長）。 */
function item(elements: number[][]): number[] {
  const body = elements.flat();
  return [0xfe, 0xff, 0x00, 0xe0, body.length & 0xff, (body.length >> 8) & 0xff, (body.length >> 16) & 0xff, (body.length >> 24) & 0xff, ...body];
}

function dicomdir(images: { sop: string; ref: string[]; num: string; sopClass?: string }[]): Uint8Array {
  const rec = (type: string, extra: number[][]) => item([el(0x0004, 0x1430, "CS", type), ...extra]);
  const records = [
    rec("PATIENT", [el(0x0010, 0x0010, "PN", "Doe^Jane"), el(0x0010, 0x0020, "LO", "P1")]),
    rec("STUDY", [el(0x0020, 0x000d, "UI", "1.2.3"), el(0x0008, 0x0020, "DA", "20260101"), el(0x0008, 0x1030, "LO", "study")]),
    rec("SERIES", [el(0x0020, 0x000e, "UI", "1.2.3.4"), el(0x0008, 0x0060, "CS", "CT"), el(0x0020, 0x0011, "IS", "1"), el(0x0008, 0x103e, "LO", "ser")]),
    ...images.map((im) =>
      rec("IMAGE", [
        el(0x0004, 0x1500, "CS", im.ref.join("\\")),
        el(0x0004, 0x1511, "UI", im.sop),
        el(0x0020, 0x0013, "IS", im.num),
        ...(im.sopClass ? [el(0x0004, 0x1510, "UI", im.sopClass)] : []),
      ]),
    ),
  ];
  const seq = el(0x0004, 0x1220, "SQ", records.flat());
  // 128 バイトのプリアンブル + "DICM" + ファイルメタ（Transfer Syntax = Explicit VR LE）+ データセット
  const meta = el(0x0002, 0x0010, "UI", "1.2.840.10008.1.2.1");
  const metaGroupLen = el(0x0002, 0x0000, "UL", [meta.length, 0, 0, 0]);
  return new Uint8Array([...new Array(128).fill(0), 0x44, 0x49, 0x43, 0x4d, ...metaGroupLen, ...meta, ...seq]);
}

describe("parseDicomDirBytes（実体の引き当ては resolver に任せる）", () => {
  const bytes = dicomdir([
    { sop: "1.1.2", ref: ["DICOM", "P 1", "2026", "ser", "00000002.dcm"], num: "2" },
    { sop: "1.1.1", ref: ["DICOM", "P 1", "2026", "ser", "00000001.dcm"], num: "1" },
  ]);

  it("患者・検査・シリーズの木を作り、画像は InstanceNumber 昇順に並ぶ", () => {
    const m = parseDicomDirBytes(bytes, { image: (p) => ({ url: `u/${p}` }), video: () => null });
    expect(m.patients).toHaveLength(1);
    expect(m.patients[0].name).toBe("Doe Jane");
    const se = m.patients[0].studies[0].series[0];
    expect(se.modality).toBe("CT");
    expect(se.images.map((i) => i.instanceNumber)).toEqual([1, 2]);
  });

  it("正例: resolver が返した URL が各画像に入る（ReferencedFileID は / 連結の媒体相対パス）", () => {
    const m = parseDicomDirBytes(bytes, { image: (p) => ({ url: `u/${p}` }), video: () => null });
    const imgs = m.patients[0].studies[0].series[0].images;
    expect(imgs[0].url).toBe("u/DICOM/P 1/2026/ser/00000001.dcm");
    expect(imgs.every((i) => i.file === undefined)).toBe(true);
    expect(m.missingFiles).toBe(0);
  });

  it("負例: resolver が見つけられない画像は未解決として数え、実体を持たない", () => {
    const m = parseDicomDirBytes(bytes, { image: (p) => (p.endsWith("00000001.dcm") ? null : { url: "x" }), video: () => null });
    const imgs = m.patients[0].studies[0].series[0].images;
    expect(imgs[0].url).toBeUndefined();
    expect(imgs[1].url).toBe("x");
    expect(m.missingFiles).toBe(1);
  });

  it("動画の SOP クラスだけ video() を引く", () => {
    const calls: string[] = [];
    const vbytes = dicomdir([
      { sop: "9.9.9", ref: ["DICOM", "v.dcm"], num: "1", sopClass: "1.2.840.10008.5.1.4.1.1.77.1.4.1" },
      { sop: "8.8.8", ref: ["DICOM", "i.dcm"], num: "2", sopClass: "1.2.840.10008.5.1.4.1.1.2" },
    ]);
    const m = parseDicomDirBytes(vbytes, {
      image: () => ({ url: "x" }),
      video: (sop) => (calls.push(sop), { url: `v/${sop}.mp4` }),
    });
    expect(calls).toEqual(["9.9.9"]);
    const imgs = m.patients[0].studies[0].series[0].images;
    expect(imgs[0].videoUrl).toBe("v/9.9.9.mp4");
    expect(imgs[1].videoUrl).toBeUndefined();
  });
});

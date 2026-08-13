/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * SpecificCharacterSet を見て DICOM のテキストを読めることの回帰テスト。
 *
 * <p>報告された症状: 2D ビューアのオーバーレイで、ISO_IR 192 の日本語 SeriesDescription が
 * 化ける（シリーズ一覧は正しい）。原因は dicom-parser の {@code string()} がバイトを
 * 1 つずつ {@code String.fromCharCode} するだけで文字セットを見ないこと。一覧が正しかったのは、
 * あちらが backend の REST を通り dcm4che が正しくデコードしていたため。
 */
import { describe, expect, it } from "vitest";
import { charsetToEncoding, decodeDicomBytes, readDicomString } from "./dicomText";

const utf8 = (s: string) => new TextEncoder().encode(s);

/** dicom-parser の DataSet を最小限だけ模す。 */
function fakeDataSet(values: Record<string, Uint8Array>, charset?: string) {
  const parts: Uint8Array[] = [];
  const elements: Record<string, { dataOffset: number; length: number }> = {};
  let offset = 0;
  for (const [tag, bytes] of Object.entries(values)) {
    elements[tag] = { dataOffset: offset, length: bytes.length };
    parts.push(bytes);
    offset += bytes.length;
  }
  const byteArray = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) {
    byteArray.set(p, at);
    at += p.length;
  }
  return {
    byteArray,
    elements,
    // dicom-parser と同じ「1 バイト 1 文字」の読み方
    string(key: string): string | undefined {
      if (key === "x00080005") return charset;
      const el = elements[key];
      if (!el) return undefined;
      let s = "";
      for (let i = 0; i < el.length; i++) s += String.fromCharCode(byteArray[el.dataOffset + i]);
      return s;
    },
  };
}

describe("charsetToEncoding", () => {
  it("ISO_IR 192 は UTF-8", () => {
    expect(charsetToEncoding("ISO_IR 192")).toBe("utf-8");
  });

  it("未指定・空は ASCII（DICOM の既定）", () => {
    expect(charsetToEncoding(null)).toBe("ascii");
    expect(charsetToEncoding("")).toBe("ascii");
  });

  it("複数値では、先頭が空でも 2 番目の文字集合を採る", () => {
    // 日本語データは「先頭=既定(空)、2番目=ISO 2022 IR 87」の形が多い
    expect(charsetToEncoding("\\ISO 2022 IR 87")).toBe("iso-2022-jp");
  });

  it("前後の空白と大小文字を吸収する", () => {
    expect(charsetToEncoding("  iso_ir 192 ")).toBe("utf-8");
  });

  it("知らない値は ASCII に落とす（例外にしない）", () => {
    expect(charsetToEncoding("ISO_IR 9999")).toBe("ascii");
  });
});

describe("decodeDicomBytes", () => {
  it("★ISO_IR 192 の日本語を正しく読む（報告された症状の核心）", () => {
    const bytes = utf8("腹部 単純 CT");
    expect(decodeDicomBytes(bytes, "ISO_IR 192")).toBe("腹部 単純 CT");
  });

  it("同じバイト列を文字セット無しで読むと化ける（従来の挙動）", () => {
    const bytes = utf8("腹部 単純 CT");
    const broken = decodeDicomBytes(bytes, null);
    expect(broken).not.toBe("腹部 単純 CT");
    // 1 バイト 1 文字になるので、文字数はバイト数と一致する
    expect(broken.length).toBe(bytes.length);
  });

  it("ASCII は文字セットに関わらずそのまま", () => {
    const bytes = utf8("CHEST CT");
    expect(decodeDicomBytes(bytes, "ISO_IR 192")).toBe("CHEST CT");
    expect(decodeDicomBytes(bytes, null)).toBe("CHEST CT");
  });
});

describe("readDicomString", () => {
  const SERIES_DESCRIPTION = "x0008103e";

  it("★ISO_IR 192 の SeriesDescription を化けずに返す", () => {
    const ds = fakeDataSet({ [SERIES_DESCRIPTION]: utf8("腹部 単純 CT") }, "ISO_IR 192");
    expect(readDicomString(ds, "0008103E")).toBe("腹部 単純 CT");
    // 素の dicom-parser 相当では化けることも同時に示す
    expect(ds.string(SERIES_DESCRIPTION)).not.toBe("腹部 単純 CT");
  });

  it("タグ名の大小文字を問わない", () => {
    const ds = fakeDataSet({ [SERIES_DESCRIPTION]: utf8("胸部") }, "ISO_IR 192");
    expect(readDicomString(ds, "0008103e")).toBe("胸部");
  });

  it("末尾の空白と NULL 詰めを落とす", () => {
    const padded = new Uint8Array([...utf8("胸部"), 0x20]);
    const ds = fakeDataSet({ [SERIES_DESCRIPTION]: padded }, "ISO_IR 192");
    expect(readDicomString(ds, "0008103E")).toBe("胸部");

    const nulled = new Uint8Array([...utf8("CT"), 0x00]);
    const ds2 = fakeDataSet({ [SERIES_DESCRIPTION]: nulled }, "ISO_IR 192");
    expect(readDicomString(ds2, "0008103E")).toBe("CT");
  });

  it("値が無ければ null", () => {
    const ds = fakeDataSet({}, "ISO_IR 192");
    expect(readDicomString(ds, "0008103E")).toBeNull();
  });

  it("空文字は null（オーバーレイに空行を出さない）", () => {
    const ds = fakeDataSet({ [SERIES_DESCRIPTION]: new Uint8Array([0x20, 0x20]) }, "ISO_IR 192");
    expect(readDicomString(ds, "0008103E")).toBeNull();
  });

  it("DataSet が無くても落ちない", () => {
    expect(readDicomString(null, "0008103E")).toBeNull();
  });

  it("文字セットが無ければ ASCII として読む（従来どおり）", () => {
    const ds = fakeDataSet({ [SERIES_DESCRIPTION]: utf8("CHEST CT") });
    expect(readDicomString(ds, "0008103E")).toBe("CHEST CT");
  });
});

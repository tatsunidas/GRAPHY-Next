import { describe, expect, it } from "vitest";
import { buildStoredZip, crc32 } from "./zipStore";

const enc = new TextEncoder();

/** リトルエンディアンの u32/u16 読み出し。 */
function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}
function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

describe("crc32", () => {
  it("既知ベクタ（\"123456789\" = 0xCBF43926）", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
  });

  it("空データは 0", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("1 バイト違えば値が変わる", () => {
    expect(crc32(enc.encode("a"))).not.toBe(crc32(enc.encode("b")));
  });
});

describe("buildStoredZip", () => {
  const entries = [
    { name: "frame-0001.png", data: enc.encode("PNG-A") },
    { name: "フレーム.txt", data: enc.encode("日本語") },
  ];

  it("ローカルヘッダのシグネチャで始まる", () => {
    const zip = buildStoredZip(entries);
    expect(u32(zip, 0)).toBe(0x04034b50);
  });

  it("End of central directory がエントリ数を持つ", () => {
    const zip = buildStoredZip(entries);
    // EOCD は末尾 22 バイト（コメント無し）。
    const eocd = zip.length - 22;
    expect(u32(zip, eocd)).toBe(0x06054b50);
    expect(u16(zip, eocd + 8)).toBe(2);
    expect(u16(zip, eocd + 10)).toBe(2);
  });

  it("無圧縮なので compressed size = uncompressed size", () => {
    const zip = buildStoredZip([entries[0]]);
    expect(u16(zip, 8)).toBe(0); // method = store
    expect(u32(zip, 18)).toBe(entries[0].data.length);
    expect(u32(zip, 22)).toBe(entries[0].data.length);
  });

  it("CRC がエントリの実データと一致する", () => {
    const zip = buildStoredZip([entries[0]]);
    expect(u32(zip, 14)).toBe(crc32(entries[0].data));
  });

  it("UTF-8 フラグが立つ（日本語ファイル名が化けない）", () => {
    const zip = buildStoredZip(entries);
    expect(u16(zip, 6) & 0x0800).toBe(0x0800);
  });

  it("中央ディレクトリのオフセットとサイズが整合する", () => {
    const zip = buildStoredZip(entries);
    const eocd = zip.length - 22;
    const cdSize = u32(zip, eocd + 12);
    const cdOffset = u32(zip, eocd + 16);
    expect(cdOffset + cdSize + 22).toBe(zip.length);
    expect(u32(zip, cdOffset)).toBe(0x02014b50);
  });

  it("同じ入力なら同じバイト列（タイムスタンプを固定してある）", () => {
    expect(Array.from(buildStoredZip(entries))).toEqual(Array.from(buildStoredZip(entries)));
  });

  it("空でも壊れない", () => {
    const zip = buildStoredZip([]);
    expect(zip.length).toBe(22);
    expect(u32(zip, 0)).toBe(0x06054b50);
  });
});

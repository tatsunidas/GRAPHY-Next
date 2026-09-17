/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 32-bit 浮動小数点のグレースケール TIFF を書き出す（無圧縮・リトルエンディアン・1 ページ 1 ストリップ）。
 * ImageJ / Fiji でそのまま 32-bit 画像（複数ページならスタック）として開ける最小構成。
 * フーリエ解析の書き出しで使う。
 *
 * <p>複数ページのときは ImageJ の流儀に合わせる: 1 枚目の IFD に ImageDescription
 * （`ImageJ=…\nimages=N\nslices=N\n…`）を持たせ、画素データは**全ページ連続**で並べる
 * （ImageJ は `images=` があると 1 枚目の StripOffsets から連続して読むため）。
 * 各ページの IFD も正しい StripOffsets を持つので、ImageJ 以外の TIFF リーダーでも読める。
 */

const SHORT = 3;
const LONG = 4;
const ASCII = 2;
const BYTE = 1;

/** row-major の Float32Array を 32-bit float TIFF のバイト列にする。 */
export function encodeFloat32Tiff(values: Float32Array, width: number, height: number): Uint8Array {
  return encodeFloat32TiffStack([values], width, height);
}

/** ImageJ の独自メタデータ（Image > Show Info の本文とスライスラベル）。 */
export interface ImageJMeta {
  /** Show Info に出る本文。 */
  info?: string;
  /** スライスごとのラベル（ImageJ のスライス表示・`getInfo("slice.label")`）。 */
  labels?: string[];
  /** 画像プロパティ（`imp.getProp(key)`）。ImageJ の Inverse FFT は "Original width/height" を読む。 */
  properties?: [string, string][];
}

/**
 * ImageJ の MetaData（タグ 50838 / 50839）ブロックを作る。
 * 形式: ヘッダ = "IJIJ" ＋ (型, 個数) の組、続いて各データを UTF-16 で。整数と文字はファイルの
 * バイト順（ここではリトルエンディアン）で書く（ImageJ の TiffDecoder はバイト順に従って読む）。
 */
function imageJMetaBlocks(meta: ImageJMeta): { counts: number[]; bytes: Uint8Array } | null {
  const entries: [number, string[]][] = [];
  if (meta.info) entries.push([0x696e666f, [meta.info]]); // "info"
  if (meta.labels?.length) entries.push([0x6c61626c, meta.labels]); // "labl"
  if (meta.properties?.length) entries.push([0x70726f70, meta.properties.flat()]); // "prop"（key, value の交互）
  if (!entries.length) return null;
  const headerSize = 4 + entries.length * 8;
  const strings = entries.flatMap(([, v]) => v);
  const counts = [headerSize, ...strings.map((x) => x.length * 2)];
  const bytes = new Uint8Array(counts.reduce((a, b) => a + b, 0));
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0x494a494a, true); // "IJIJ"
  entries.forEach(([type, v], i) => {
    dv.setUint32(4 + i * 8, type, true);
    dv.setUint32(8 + i * 8, v.length, true);
  });
  let p = headerSize;
  for (const str of strings) {
    for (let i = 0; i < str.length; i++) dv.setUint16(p + i * 2, str.charCodeAt(i), true);
    p += str.length * 2;
  }
  return { counts, bytes };
}

/**
 * 同じ大きさの Float32Array 群を 1 ファイルの複数ページ TIFF（ImageJ ではスタック）にする。
 * `meta` を渡すと ImageJ のメタデータ（Show Info の本文・スライスラベル）を 1 枚目に持たせる。
 */
export function encodeFloat32TiffStack(
  slices: Float32Array[],
  width: number,
  height: number,
  meta: ImageJMeta = {},
): Uint8Array {
  if (!slices.length) throw new Error("no slices");
  for (const s of slices) if (s.length !== width * height) throw new Error("values.length !== width * height");
  const pages = slices.length;
  const pageBytes = width * height * 4;

  let description: Uint8Array | null = null;
  if (pages > 1) {
    const text = `ImageJ=1.54p\nimages=${pages}\nslices=${pages}\n`;
    description = new Uint8Array(text.length + 1); // ASCII は NUL 終端
    for (let i = 0; i < text.length; i++) description[i] = text.charCodeAt(i);
  }
  const ijMeta = imageJMetaBlocks(meta);

  const tagCount = (page: number) => (page === 0 ? 11 + (description ? 1 : 0) + (ijMeta ? 2 : 0) : 11);
  const ifdSize = (page: number) => 2 + tagCount(page) * 12 + 4;
  const ifdOffsets: number[] = [];
  let p = 8;
  for (let i = 0; i < pages; i++) {
    ifdOffsets.push(p);
    p += ifdSize(i);
  }
  const descOffset = p;
  if (description) p += description.length;
  const metaCountsOffset = p;
  if (ijMeta) p += ijMeta.counts.length * 4;
  const metaOffset = p;
  if (ijMeta) p += ijMeta.bytes.length;
  const dataOffset = p;
  const total = dataOffset + pageBytes * pages;

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint8(0, 0x49); // "II"
  dv.setUint8(1, 0x49);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdOffsets[0], true);

  for (let page = 0; page < pages; page++) {
    const stripOffset = dataOffset + page * pageBytes;
    // タグは番号の昇順で並べる（TIFF 6.0 の要件）。
    const tags: [number, number, number, number][] = [
      [256, LONG, 1, width], // ImageWidth
      [257, LONG, 1, height], // ImageLength
      [258, SHORT, 1, 32], // BitsPerSample
      [259, SHORT, 1, 1], // Compression = none
      [262, SHORT, 1, 1], // PhotometricInterpretation = BlackIsZero
    ];
    if (page === 0 && description) tags.push([270, ASCII, description.length, descOffset]); // ImageDescription
    tags.push(
      [273, LONG, 1, stripOffset], // StripOffsets
      [277, SHORT, 1, 1], // SamplesPerPixel
      [278, LONG, 1, height], // RowsPerStrip
      [279, LONG, 1, pageBytes], // StripByteCounts
      [284, SHORT, 1, 1], // PlanarConfiguration = chunky
      [339, SHORT, 1, 3], // SampleFormat = IEEE floating point
    );
    if (page === 0 && ijMeta) {
      tags.push([50838, LONG, ijMeta.counts.length, metaCountsOffset]); // ImageJ MetaDataByteCounts
      tags.push([50839, BYTE, ijMeta.bytes.length, metaOffset]); // ImageJ MetaData
    }
    let q = ifdOffsets[page];
    dv.setUint16(q, tags.length, true);
    q += 2;
    for (const [tag, type, count, value] of tags) {
      dv.setUint16(q, tag, true);
      dv.setUint16(q + 2, type, true);
      dv.setUint32(q + 4, count, true);
      if (type === SHORT && count === 1) dv.setUint16(q + 8, value, true);
      else dv.setUint32(q + 8, value, true);
      q += 12;
    }
    dv.setUint32(q, page + 1 < pages ? ifdOffsets[page + 1] : 0, true); // 次の IFD
  }

  const out = new Uint8Array(buf);
  if (description) out.set(description, descOffset);
  if (ijMeta) {
    ijMeta.counts.forEach((c, i) => dv.setUint32(metaCountsOffset + i * 4, c, true));
    out.set(ijMeta.bytes, metaOffset);
  }
  for (let page = 0; page < pages; page++) {
    const s = slices[page];
    const base = dataOffset + page * pageBytes;
    for (let i = 0; i < s.length; i++) dv.setFloat32(base + i * 4, s[i], true);
  }
  return out;
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 無圧縮（stored）ZIP の組み立て（`fw/angio-design.md` §14.3）。
 *
 * <p>連番 PNG を 1 ファイルにまとめて渡すためだけの最小実装。**依存を増やさない**ために自前で書く
 * （PNG は既に圧縮済みなので、ZIP 側で再圧縮しても縮まない ＝ stored で十分）。
 *
 * <p>ブラウザのダウンロードは 1 回で済ませたい。96 フレームを個別にダウンロードさせると
 * 96 個のダウンロード確認が出て実用にならない。
 */

/** ZIP に入れる 1 エントリ。 */
export interface ZipEntry {
  /** ZIP 内のパス（UTF-8）。 */
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** CRC-32（IEEE 802.3）。ZIP のチェックサム。 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

class ByteWriter {
  private parts: Uint8Array[] = [];
  private length = 0;

  get offset(): number {
    return this.length;
  }

  u16(v: number): void {
    this.push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff]));
  }

  u32(v: number): void {
    this.push(new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]));
  }

  push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/** UTF-8 フラグ（汎用ビット 11）。日本語ファイル名でも文字化けしないように立てる。 */
const FLAG_UTF8 = 0x0800;
/** 無圧縮。 */
const METHOD_STORE = 0;

/**
 * 無圧縮 ZIP を組み立てる。
 *
 * <p>タイムスタンプは**固定値 0**にしてある（同じ入力なら同じバイト列＝再現可能）。
 * ZIP の「更新日時」は表示上 1980-01-01 になるが、目的は一括受け渡しなので実害はない。
 */
export function buildStoredZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const body = new ByteWriter();
  const central = new ByteWriter();

  for (const e of entries) {
    const name = encoder.encode(e.name);
    const crc = crc32(e.data);
    const localOffset = body.offset;

    // Local file header
    body.u32(0x04034b50);
    body.u16(20); // version needed
    body.u16(FLAG_UTF8);
    body.u16(METHOD_STORE);
    body.u16(0); // mod time
    body.u16(0); // mod date
    body.u32(crc);
    body.u32(e.data.length); // compressed size = uncompressed（stored）
    body.u32(e.data.length);
    body.u16(name.length);
    body.u16(0); // extra length
    body.push(name);
    body.push(e.data);

    // Central directory header
    central.u32(0x02014b50);
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(FLAG_UTF8);
    central.u16(METHOD_STORE);
    central.u16(0);
    central.u16(0);
    central.u32(crc);
    central.u32(e.data.length);
    central.u32(e.data.length);
    central.u16(name.length);
    central.u16(0); // extra
    central.u16(0); // comment
    central.u16(0); // disk number
    central.u16(0); // internal attrs
    central.u32(0); // external attrs
    central.u32(localOffset);
    central.push(name);
  }

  const centralBytes = central.concat();
  const bodyBytes = body.concat();

  const end = new ByteWriter();
  end.u32(0x06054b50);
  end.u16(0); // disk
  end.u16(0); // disk with central dir
  end.u16(entries.length);
  end.u16(entries.length);
  end.u32(centralBytes.length);
  end.u32(bodyBytes.length);
  end.u16(0); // comment length

  const out = new Uint8Array(bodyBytes.length + centralBytes.length + end.offset);
  out.set(bodyBytes, 0);
  out.set(centralBytes, bodyBytes.length);
  out.set(end.concat(), bodyBytes.length + centralBytes.length);
  return out;
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { encodeFloat32Tiff, encodeFloat32TiffStack } from "./tiffFloat32";

describe("encodeFloat32Tiff", () => {
  it("ヘッダ・IFD・画素が 32-bit float TIFF として読み戻せる", () => {
    const w = 3;
    const h = 2;
    const vals = Float32Array.from([0, -1.5, 3.25, 1e6, Number.NaN, 7]);
    const bytes = encodeFloat32Tiff(vals, w, h);
    const dv = new DataView(bytes.buffer);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe("II");
    expect(dv.getUint16(2, true)).toBe(42);
    const ifd = dv.getUint32(4, true);
    const count = dv.getUint16(ifd, true);
    const tags = new Map<number, number>();
    let prev = 0;
    for (let i = 0; i < count; i++) {
      const p = ifd + 2 + i * 12;
      const tag = dv.getUint16(p, true);
      expect(tag).toBeGreaterThan(prev);
      prev = tag;
      const type = dv.getUint16(p + 2, true);
      tags.set(tag, type === 3 ? dv.getUint16(p + 8, true) : dv.getUint32(p + 8, true));
    }
    expect(tags.get(256)).toBe(w);
    expect(tags.get(257)).toBe(h);
    expect(tags.get(258)).toBe(32);
    expect(tags.get(339)).toBe(3);
    expect(tags.get(279)).toBe(w * h * 4);
    const off = tags.get(273)!;
    expect(off + w * h * 4).toBe(bytes.length);
    for (let i = 0; i < vals.length; i++) {
      const v = dv.getFloat32(off + i * 4, true);
      if (Number.isNaN(vals[i])) expect(Number.isNaN(v)).toBe(true);
      else expect(v).toBe(vals[i]);
    }
  });

  it("複数ページ: IFD が連鎖し、画素は連続して並び、1 枚目に ImageJ のスタック記述を持つ", () => {
    const w = 2;
    const h = 2;
    const a = Float32Array.from([1, -2, 3.5, -4.25]);
    const b = Float32Array.from([-0.5, 6, -7, 8e-3]);
    const bytes = encodeFloat32TiffStack([a, b], w, h, { info: "手順\nline2", labels: ["Re", "Im"], properties: [["Original width", "300"]] });
    const dv = new DataView(bytes.buffer);
    const readIfd = (off: number) => {
      const count = dv.getUint16(off, true);
      const tags = new Map<number, { type: number; count: number; value: number }>();
      for (let i = 0; i < count; i++) {
        const p = off + 2 + i * 12;
        const type = dv.getUint16(p + 2, true);
        tags.set(dv.getUint16(p, true), {
          type,
          count: dv.getUint32(p + 4, true),
          value: type === 3 ? dv.getUint16(p + 8, true) : dv.getUint32(p + 8, true),
        });
      }
      return { tags, next: dv.getUint32(off + 2 + count * 12, true) };
    };
    const ifd0 = readIfd(dv.getUint32(4, true));
    expect(ifd0.next).toBeGreaterThan(0);
    const ifd1 = readIfd(ifd0.next);
    expect(ifd1.next).toBe(0);

    const desc = ifd0.tags.get(270)!;
    const text = new TextDecoder().decode(bytes.subarray(desc.value, desc.value + desc.count - 1));
    expect(text.startsWith("ImageJ=")).toBe(true);
    expect(text).toContain("images=2\n");
    expect(text).toContain("slices=2\n");
    expect(ifd1.tags.has(270)).toBe(false);

    // ImageJ メタデータ: ヘッダ "IJIJ" ＋ info 1 件 ＋ labl 2 件、本文は UTF-16LE。
    const counts = ifd0.tags.get(50838)!;
    const metaTag = ifd0.tags.get(50839)!;
    const cnt = Array.from({ length: counts.count }, (_, i) => dv.getUint32(counts.value + i * 4, true));
    expect(cnt).toEqual([4 + 3 * 8, "手順\nline2".length * 2, 4, 4, "Original width".length * 2, 6]);
    expect(metaTag.count).toBe(cnt.reduce((x, y) => x + y, 0));
    expect(dv.getUint32(metaTag.value, true)).toBe(0x494a494a);
    const utf16 = (off: number, len: number) => new TextDecoder("utf-16le").decode(bytes.subarray(off, off + len));
    expect(utf16(metaTag.value + cnt[0], cnt[1])).toBe("手順\nline2");
    expect(utf16(metaTag.value + cnt[0] + cnt[1], 4)).toBe("Re");
    expect(utf16(metaTag.value + cnt[0] + cnt[1] + 4, 4)).toBe("Im");
    expect(dv.getUint32(metaTag.value + 4 + 2 * 8, true)).toBe(0x70726f70); // "prop"
    expect(dv.getUint32(metaTag.value + 8 + 2 * 8, true)).toBe(2); // key と value で 2 件
    expect(utf16(metaTag.value + cnt[0] + cnt[1] + 8, cnt[4])).toBe("Original width");
    expect(utf16(metaTag.value + cnt[0] + cnt[1] + 8 + cnt[4], cnt[5])).toBe("300");

    const off0 = ifd0.tags.get(273)!.value;
    const off1 = ifd1.tags.get(273)!.value;
    expect(off1).toBe(off0 + w * h * 4); // ImageJ は連続配置を前提に読む
    expect(off1 + w * h * 4).toBe(bytes.length);
    for (let i = 0; i < 4; i++) {
      expect(dv.getFloat32(off0 + i * 4, true)).toBe(a[i]);
      expect(dv.getFloat32(off1 + i * 4, true)).toBe(b[i]);
    }
    for (const ifd of [ifd0, ifd1]) {
      expect(ifd.tags.get(258)!.value).toBe(32);
      expect(ifd.tags.get(339)!.value).toBe(3);
    }
  });

  it("大きさが合わなければ拒否する", () => {
    expect(() => encodeFloat32Tiff(new Float32Array(5), 2, 2)).toThrow();
  });
});

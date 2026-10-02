/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * H59 の結果（無圧縮の outputs.zip）から 1 ファイルずつ取り出す読み手。
 * 本体（Java の ZipOutputStream・STORED）が書く形と同じものを手で組む。
 */
import { describe, expect, it } from "vitest";
import { readStoredZipEntry } from "./pluginComputeApi";

const enc = new TextEncoder();

/** 無圧縮の zip を組む（CRC は読み手が見ないので 0）。 */
function storedZip(files: { name: string; data: Uint8Array; method?: number }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, f.method ?? 0, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(10, f.method ?? 0, true);
    c.setUint32(20, f.data.length, true);
    c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

describe("readStoredZipEntry", () => {
  const mask = new Uint8Array([0, 1, 1, 0, 255]);
  const zip = storedZip([
    { name: "mask.npy", data: mask },
    { name: "sub/summary.json", data: enc.encode('{"voxels":3}') },
  ]);

  it("名前で 1 ファイル取り出す（下の階層も）", () => {
    expect(Array.from(readStoredZipEntry(zip, "mask.npy") ?? [])).toEqual([0, 1, 1, 0, 255]);
    expect(new TextDecoder().decode(readStoredZipEntry(zip, "sub/summary.json")!)).toBe('{"voxels":3}');
  });

  it("無い名前は null", () => {
    expect(readStoredZipEntry(zip, "nope.txt")).toBeNull();
  });

  it("圧縮されたエントリ・zip でないものは null（読めないものを読めた振りをしない）", () => {
    expect(readStoredZipEntry(storedZip([{ name: "a", data: mask, method: 8 }]), "a")).toBeNull();
    expect(readStoredZipEntry(new Uint8Array(40), "a")).toBeNull();
  });
});

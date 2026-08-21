#!/usr/bin/env node
// GRAPHY-Next Benchmark
// Copyright (C) 2026 Visionary Imaging Services, Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GNBP が書き出す DICOM を読むだけの最小の読み取り器。
//
// 元は run_rigid_registration.mjs の中にあった。GNBP-5N を使う採点が位置合わせ以外にも
// 増えた（サブトラクションの強度正規化ほか）ため、**同じ読み取り器を 2 つ書かない**よう
// 切り出してある。中身は動かしていない。
//
// ⚠ 汎用の DICOM パーサにはしないこと。ここが一般化すると、アプリが持っている実装の
//    2 本目になり、失敗したときに「エンジンが悪いのかベンチのパーサが悪いのか」が
//    分からなくなる（切り出す前からある方針）。

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ── minimal DICOM reader ─────────────────────────────────────────────────────

/**
 * Read the uncompressed Explicit VR Little Endian series the phantom writes.
 *
 * <p>Deliberately minimal: this reads the two phantoms this bench writes and
 * nothing else. A general DICOM parser here would be a second implementation of
 * something the application already has, with its own bugs, and would make a
 * failure ambiguous ("is the engine wrong or is the benchmark's parser wrong?").
 *
 * <p>Returns an <b>array</b> of slices, because GNBP-5N is reconstructed SPECT
 * and arrives the way real SPECT does: every slice inside one multi-frame NM
 * instance. That format also hides its geometry — <b>NM carries no
 * ImagePositionPatient at the root and none per frame</b>; the position of the
 * first slice lives in {@code DetectorInformationSequence} and the rest are
 * stacked along the slice normal by the reader (the same thing GRAPHY's
 * {@code NmFrameExpander} does). Reading such a file as "one image" is exactly
 * the mistake that made the application open a 48-slice SPECT as a cine.
 */
export function readDicom(path) {
  const buf = readFileSync(path);
  if (buf.length < 132 || buf.toString("latin1", 128, 132) !== "DICM") {
    throw new Error(`not a Part-10 file: ${path}`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tags = new Map();
  let pos = 132;
  let pixelOffset = -1;
  let pixelLength = 0;

  while (pos + 8 <= buf.length) {
    const group = dv.getUint16(pos, true);
    const element = dv.getUint16(pos + 2, true);
    const vr = buf.toString("latin1", pos + 4, pos + 6);
    let len, valueStart;
    if (["OB", "OW", "OF", "SQ", "UT", "UN"].includes(vr)) {
      len = dv.getUint32(pos + 8, true);
      valueStart = pos + 12;
    } else {
      len = dv.getUint16(pos + 6, true);
      valueStart = pos + 8;
    }
    const tag = `${group.toString(16).padStart(4, "0")}${element.toString(16).padStart(4, "0")}`;
    if (tag === "7fe00010") { pixelOffset = valueStart; pixelLength = len; break; }
    if (len === 0xffffffff) {
      throw new Error("undefined-length item is not supported (the phantom never writes one)");
    }
    tags.set(tag, { vr, start: valueStart, len });
    pos = valueStart + len + (len % 2);
  }
  if (pixelOffset < 0) throw new Error(`no PixelData in ${path}`);

  /**
   * 値の取り出し。**VR ごとに復号する** — US/UL のような 2 進 VR を文字列として
   * 読むと `Number()` が NaN を返し、Rows/Columns が静かに壊れる（実際に踏んだ）。
   */
  const accessors = (map) => {
  const num = (tag, i = 0) => {
    const t = map.get(tag);
    if (!t) return undefined;
    switch (t.vr) {
      case "US": return dv.getUint16(t.start + i * 2, true);
      case "SS": return dv.getInt16(t.start + i * 2, true);
      case "UL": return dv.getUint32(t.start + i * 4, true);
      case "SL": return dv.getInt32(t.start + i * 4, true);
      case "FL": return dv.getFloat32(t.start + i * 4, true);
      case "FD": return dv.getFloat64(t.start + i * 8, true);
      default: {
        const parts = buf.toString("latin1", t.start, t.start + t.len).trim().split("\\");
        return Number(parts[i]);
      }
    }
  };
  const str = (tag) => {
    const t = map.get(tag);
    return t ? buf.toString("latin1", t.start, t.start + t.len).trim() : "";
  };
    return { num, str };
  };
  const { num, str } = accessors(tags);

  /**
   * 定義長シーケンスの最初のアイテムの中身。ここでしか要らないので最小限に留める
   * （このベンチのファントムは両方とも定義長で書く。未定義長は上のループが弾く）。
   */
  const firstItem = (tag) => {
    const sq = tags.get(tag);
    if (!sq || sq.len < 8) return null;
    if (dv.getUint16(sq.start, true) !== 0xfffe || dv.getUint16(sq.start + 2, true) !== 0xe000) return null;
    const itemLen = dv.getUint32(sq.start + 4, true);
    if (itemLen === 0xffffffff) {
      throw new Error("undefined-length sequence item is not supported (the phantom never writes one)");
    }
    const inner = new Map();
    let p = sq.start + 8;
    const end = Math.min(sq.start + 8 + itemLen, sq.start + sq.len);
    while (p + 8 <= end) {
      const g = dv.getUint16(p, true);
      const e = dv.getUint16(p + 2, true);
      const vr = buf.toString("latin1", p + 4, p + 6);
      let len, vs;
      if (["OB", "OW", "OF", "SQ", "UT", "UN"].includes(vr)) { len = dv.getUint32(p + 8, true); vs = p + 12; }
      else { len = dv.getUint16(p + 6, true); vs = p + 8; }
      if (len === 0xffffffff) throw new Error("undefined-length element inside a sequence item");
      inner.set(`${g.toString(16).padStart(4, "0")}${e.toString(16).padStart(4, "0")}`, { vr, start: vs, len });
      p = vs + len + (len % 2);
    }
    return accessors(inner);
  };

  const rows = num("00280010");
  const cols = num("00280011");
  const stored = new Uint16Array(buf.buffer, buf.byteOffset + pixelOffset, pixelLength / 2);
  const slope = num("00281053") ?? 1;
  const intercept = num("00281052") ?? 0;
  const frames = Math.max(1, Math.trunc(num("00280008") ?? 1));
  const meta = {
    pixelSpacingRow: num("00280030", 0),
    pixelSpacingCol: num("00280030", 1),
    frameOfReferenceUid: str("00200052"),
    seriesDescription: str("0008103e"),
  };
  const slice = (k, ipp, iop) => {
    const pixels = new Float32Array(rows * cols);
    const off = k * rows * cols;
    for (let n = 0; n < pixels.length; n++) pixels[n] = stored[off + n] * slope + intercept;
    return { rows, cols, pixels, ipp, iop, ...meta };
  };

  if (frames === 1) {
    return [slice(0,
      [num("00200032", 0), num("00200032", 1), num("00200032", 2)],
      [0, 1, 2, 3, 4, 5].map((i) => num("00200037", i)))];
  }

  // ── multi-frame NM (reconstructed SPECT) ──────────────────────────────────
  const det = firstItem("00540022");   // DetectorInformationSequence
  const iop = det ? [0, 1, 2, 3, 4, 5].map((i) => det.num("00200037", i))
                  : [0, 1, 2, 3, 4, 5].map((i) => num("00200037", i));
  const origin = det ? [0, 1, 2].map((i) => det.num("00200032", i))
                     : [0, 1, 2].map((i) => num("00200032", i));
  const spacing = (num("00180088") || num("00180050") || 0);
  if (!iop.every(Number.isFinite) || !origin.every(Number.isFinite) || !(spacing > 0)) {
    // 座標を捏造しない。NmFrameExpander も同じで、作れなければ「空間シリーズでない」
    // として扱う。ここで黙って 1mm 等を埋めると、以後の mm 単位の誤差がすべて嘘になる。
    throw new Error(`${path}: multi-frame NM without a usable geometry `
      + `(DetectorInformationSequence IPP/IOP + SpacingBetweenSlices)`);
  }
  const nrm = [
    iop[1] * iop[5] - iop[2] * iop[4],
    iop[2] * iop[3] - iop[0] * iop[5],
    iop[0] * iop[4] - iop[1] * iop[3],
  ];
  const nlen = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
  const unit = nrm.map((v) => v / nlen);
  const sv = tags.get("00540080");     // SliceVector, 1-based
  const sliceIndexOf = (k) => {
    if (sv && sv.vr === "US" && k * 2 + 2 <= sv.len) {
      const v = dv.getUint16(sv.start + k * 2, true);
      if (v > 0) return v - 1;
    }
    return k;
  };

  const out = [];
  for (let k = 0; k < frames; k++) {
    const i = sliceIndexOf(k);
    out.push(slice(k, [
      origin[0] + unit[0] * spacing * i,
      origin[1] + unit[1] * spacing * i,
      origin[2] + unit[2] * spacing * i,
    ], iop));
  }
  return out;
}

/** Read a directory of slices into the engine's volume type. */
export function readSeries(dir, makeVolume) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".dcm")).sort();
  if (files.length === 0) throw new Error(`no DICOM files in ${dir}`);
  const slices = files.flatMap((f) => readDicom(join(dir, f)));

  // Sort by position along the slice normal so the stack is geometrically
  // ordered rather than name-ordered. The phantom happens to write them in
  // order; relying on that would make this quietly wrong for anything else.
  const iop = slices[0].iop;
  const n = [
    iop[1] * iop[5] - iop[2] * iop[4],
    iop[2] * iop[3] - iop[0] * iop[5],
    iop[0] * iop[4] - iop[1] * iop[3],
  ];
  slices.sort((a, b) =>
    (a.ipp[0] * n[0] + a.ipp[1] * n[1] + a.ipp[2] * n[2]) -
    (b.ipp[0] * n[0] + b.ipp[1] * n[1] + b.ipp[2] * n[2]));

  const { rows, cols } = slices[0];
  const data = new Float32Array(rows * cols * slices.length);
  slices.forEach((s, k) => data.set(s.pixels, k * rows * cols));

  const step = slices.length > 1
    ? [slices[1].ipp[0] - slices[0].ipp[0], slices[1].ipp[1] - slices[0].ipp[1], slices[1].ipp[2] - slices[0].ipp[2]]
    : [n[0], n[1], n[2]];

  return {
    volume: makeVolume(
      data,
      [cols, rows, slices.length],
      iop,
      slices[0].ipp,
      slices[0].pixelSpacingCol,
      slices[0].pixelSpacingRow,
      step,
    ),
    frameOfReferenceUid: slices[0].frameOfReferenceUid,
    description: slices[0].seriesDescription,
  };
}

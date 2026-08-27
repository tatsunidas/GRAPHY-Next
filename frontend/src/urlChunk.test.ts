/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { chunkForQuery } from "./urlChunk";

/** 実データの Study Instance UID（63 文字）。 */
const uid = (n: number) =>
  `1.2.826.0.1.3680043.10.1338.${String(n).padStart(36, "0")}`;

/** 分割後の 1 リクエストぶんのクエリ値（エンコード後）の長さ。 */
const encodedLength = (chunk: string[]) => encodeURIComponent(chunk.join(",")).length;

describe("chunkForQuery", () => {
  it("空なら空（リクエストを出さない）", () => {
    expect(chunkForQuery([])).toEqual([]);
  });

  it("上限に収まるならそのまま 1 かたまり", () => {
    const ids = [uid(1), uid(2), uid(3)];
    expect(chunkForQuery(ids)).toEqual([ids]);
  });

  it("順序と全件を保つ（結果を結合すると元に戻る）", () => {
    const ids = Array.from({ length: 250 }, (_, i) => uid(i));
    const chunks = chunkForQuery(ids);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(ids);
  });

  it("🚨 どのかたまりも上限を超えない（131 スタディで 400 になった実機の条件）", () => {
    const ids = Array.from({ length: 131 }, (_, i) => uid(i));
    for (const chunk of chunkForQuery(ids)) {
      expect(encodedLength(chunk)).toBeLessThanOrEqual(3000);
    }
  });

  it("件数ではなくバイト長で切る（UID の長さが混在しても上限を守る）", () => {
    // 施設によって UID の長さは違う。固定件数で切ると「ある施設のデータでだけ落ちる」。
    const mixed = [
      ...Array.from({ length: 30 }, (_, i) => uid(i)),
      ...Array.from({ length: 30 }, (_, i) => `2.25.${i}`),
      ...Array.from({ length: 30 }, (_, i) => uid(100 + i)),
    ];
    const chunks = chunkForQuery(mixed);
    for (const chunk of chunks) expect(encodedLength(chunk)).toBeLessThanOrEqual(3000);
    expect(chunks.flat()).toEqual(mixed);
  });

  it("上限を小さくすると、そのぶん細かく割れる", () => {
    const ids = Array.from({ length: 10 }, (_, i) => uid(i));
    expect(chunkForQuery(ids, 200).length).toBeGreaterThan(chunkForQuery(ids, 1000).length);
    for (const chunk of chunkForQuery(ids, 200)) {
      expect(encodedLength(chunk)).toBeLessThanOrEqual(200);
    }
  });

  it("単体で上限を超える ID も落とさない（1 件だけのかたまりにする）", () => {
    // 分割しようがないので、空のかたまりを作って進まなくなるより「送って backend に断らせる」。
    const huge = "x".repeat(5000);
    expect(chunkForQuery([huge, uid(1)], 3000)).toEqual([[huge], [uid(1)]]);
  });

  it("エンコードで伸びる文字を長さに数える", () => {
    // PatientID 由来の "/" のように、1 文字が 3 文字（%2F）へ伸びるものがある。
    const slashy = Array.from({ length: 40 }, (_, i) => `D97258/11053/${i}`);
    for (const chunk of chunkForQuery(slashy, 200)) {
      expect(encodedLength(chunk)).toBeLessThanOrEqual(200);
    }
  });
});

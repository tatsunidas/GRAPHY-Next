import { describe, expect, it } from "vitest";

import { ippFromPlane } from "./sliceIpp";

describe("ippFromPlane（H3 の ipp）", () => {
  it("位置が 3 つの数値なら、そのまま返す", () => {
    expect(ippFromPlane({ imagePositionPatient: [-279.9, -280.0, 280.6] })).toEqual([-279.9, -280.0, 280.6]);
  });

  it("文字列の数値も数として読む（DICOM の DS）", () => {
    expect(ippFromPlane({ imagePositionPatient: ["1.5", "2", "-3"] })).toEqual([1.5, 2, -3]);
  });

  it("負例: 無い・短い・数値でない・NaN は null（0 を捏造しない）", () => {
    expect(ippFromPlane(undefined)).toBeNull();
    expect(ippFromPlane({})).toBeNull();
    expect(ippFromPlane({ imagePositionPatient: [1, 2] })).toBeNull();
    expect(ippFromPlane({ imagePositionPatient: ["a", 1, 2] })).toBeNull();
    expect(ippFromPlane({ imagePositionPatient: [1, 2, Number.NaN] })).toBeNull();
  });

  it("スライスごとに別の位置を返す（表示中スライスの値を流用しない）", () => {
    const a = ippFromPlane({ imagePositionPatient: [0, 0, 10] });
    const b = ippFromPlane({ imagePositionPatient: [0, 0, 5.58] });
    expect(a).not.toEqual(b);
  });
});

import { describe, expect, it } from "vitest";
import { buildLayoutDto, type HeaderInfo } from "./layout";

const IOP: HeaderInfo["iop"] = [1, 0, 0, 0, 1, 0]; // 軸位断。法線は +Z

function h(sop: string, o: Partial<HeaderInfo> = {}): HeaderInfo {
  return {
    sopUid: sop, url: `/${sop}`, instanceNumber: 1, ipp: [0, 0, 0], iop: IOP, rows: 4, cols: 4,
    pixelSpacing: [0.5, 0.7], frameOfReference: "1.2.3", frames: 1, sopClass: "1.2.840.10008.5.1.4.1.1.2", temporalPos: null, acqTime: null, ...o,
  };
}

describe("buildLayoutDto", () => {
  it("IPP を法線へ射影して Z 昇順に並べる（インスタンス番号の順ではない）", () => {
    const dto = buildLayoutDto([
      h("c", { instanceNumber: 1, ipp: [0, 0, 20] }),
      h("a", { instanceNumber: 3, ipp: [0, 0, 0] }),
      h("b", { instanceNumber: 2, ipp: [0, 0, 10] }),
    ]);
    expect([dto.nZ, dto.nC, dto.nT]).toEqual([3, 1, 1]);
    expect(dto.cells.sort((x, y) => x.z - y.z).map((c) => c.sopInstanceUid)).toEqual(["a", "b", "c"]);
    expect(dto.zSpatial?.map((z) => z.imagePositionPatient[2])).toEqual([0, 10, 20]);
    expect([dto.pixelSpacingRow, dto.pixelSpacingCol, dto.imageWidth, dto.imageHeight]).toEqual([0.5, 0.7, 4, 4]);
    expect(dto.frameOfReferenceUID).toBe("1.2.3");
  });

  it("同じ位置が同数ずつ繰り返すとき T 軸にする（時相位置の順）", () => {
    const dto = buildLayoutDto([
      h("a1", { ipp: [0, 0, 0], temporalPos: 1 }),
      h("a2", { ipp: [0, 0, 0], temporalPos: 2 }),
      h("b2", { ipp: [0, 0, 5], temporalPos: 2 }),
      h("b1", { ipp: [0, 0, 5], temporalPos: 1 }),
    ]);
    expect([dto.nZ, dto.nT]).toEqual([2, 2]);
    const at = (z: number, t: number) => dto.cells.find((c) => c.z === z && c.t === t)?.sopInstanceUid;
    expect([at(0, 0), at(0, 1), at(1, 0), at(1, 1)]).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("位置ごとの枚数が揃わないときは、単一の軸（位置順）にする。画像は 1 枚も落とさない", () => {
    const dto = buildLayoutDto([h("a", { ipp: [0, 0, 0] }), h("a'", { ipp: [0, 0, 0] }), h("b", { ipp: [0, 0, 5] })]);
    expect([dto.nZ, dto.nT, dto.cells.length]).toEqual([3, 1, 3]);
  });

  it("位置情報がないときはインスタンス番号の順", () => {
    const dto = buildLayoutDto([
      h("x", { instanceNumber: 2, ipp: null, iop: null }),
      h("y", { instanceNumber: 1, ipp: null, iop: null }),
    ]);
    expect(dto.cells.sort((p, q) => p.z - q.z).map((c) => c.sopInstanceUid)).toEqual(["y", "x"]);
    expect(dto.zSpatial).toBeNull();
    expect(dto.imageOrientationPatient).toBeNull();
  });

  it("マルチフレーム 1 インスタンスはフレーム軸（stackAxis=t）。フレームは 0 始まり", () => {
    const dto = buildLayoutDto([h("m", { frames: 3 })]);
    expect([dto.nZ, dto.nT]).toEqual([1, 3]);
    expect(dto.axes?.stackAxis).toBe("t");
    expect(dto.cells.map((c) => c.frame)).toEqual([0, 1, 2]);
  });

  const XA = "1.2.840.10008.5.1.4.1.1.12.1";
  it("XA は インスタンス＝ラン（Z）・フレーム＝T。短いランは最終フレームで止め、幾何は付けない（本体と同じ規則）", () => {
    const dto = buildLayoutDto([
      h("r2", { sopClass: XA, instanceNumber: 2, frames: 2 }),
      h("r1", { sopClass: XA, instanceNumber: 1, frames: 4 }),
    ]);
    expect([dto.nZ, dto.nT]).toEqual([2, 4]);
    expect(dto.axes?.stackAxis).toBe("t");
    const at = (z: number, t: number) => dto.cells.find((c) => c.z === z && c.t === t);
    expect(at(0, 0)?.sopInstanceUid).toBe("r1");
    expect([at(1, 0)?.frame, at(1, 1)?.frame, at(1, 3)?.frame]).toEqual([0, 1, 1]);
    expect(dto.imageOrientationPatient).toBeNull();
    expect(dto.pixelSpacingRow).toBe(0);
  });

  it("フレーム数 1 の XRF でも frame=0 を持つ（先頭フレームを正しく指す）", () => {
    const dto = buildLayoutDto([h("rf", { sopClass: "1.2.840.10008.5.1.4.1.1.12.2", frames: 1 })]);
    expect([dto.nZ, dto.nT, dto.cells[0].frame]).toEqual([1, 1, 0]);
    expect(dto.axes?.stackAxis).toBe("t");
  });
});

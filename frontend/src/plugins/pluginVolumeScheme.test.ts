/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 合成ローダ（H31/H32 の土台）の**純粋な部分**。
 *
 * 画像を実際に組む `buildImage` は Cornerstone の `VoxelManager` と `metaData` を要るので
 * ここでは触れない。代わりに、**間違えると「もっともらしいが別スライスの絵」になる**
 * imageId の組み立てと入力の検査を固定する。
 */
import { metaData } from "@cornerstonejs/core";
import { describe, expect, it } from "vitest";
import {
  autoWindow,
  createValueStack,
  parsePluginVolumeImageId,
  pluginVolumeImageId,
  registerPluginVolumeLoader,
  releaseValueStack,
  valueStackCount,
  PLUGIN_VOLUME_SCHEME,
} from "./pluginVolumeScheme";

const DIMS: [number, number, number] = [4, 3, 2];
const nativeIds = ["wadouri:a", "wadouri:b"];
const data = () => new Float32Array(DIMS[0] * DIMS[1] * DIMS[2]);

describe("imageId の組み立てと分解", () => {
  it("往復する", () => {
    const id = pluginVolumeImageId("tok-1", 7);
    expect(id.startsWith(`${PLUGIN_VOLUME_SCHEME}:`)).toBe(true);
    expect(parsePluginVolumeImageId(id)).toEqual({ token: "tok-1", z: 7 });
  });

  it("他のスキームや壊れた形は null（黙って引き受けない）", () => {
    expect(parsePluginVolumeImageId("wadouri:x")).toBeNull();
    expect(parsePluginVolumeImageId(`${PLUGIN_VOLUME_SCHEME}:tok`)).toBeNull();
    expect(parsePluginVolumeImageId(`${PLUGIN_VOLUME_SCHEME}:tok#x`)).toBeNull();
    expect(parsePluginVolumeImageId(`${PLUGIN_VOLUME_SCHEME}:tok#-1`)).toBeNull();
    expect(parsePluginVolumeImageId(`${PLUGIN_VOLUME_SCHEME}:tok#1.5`)).toBeNull();
    expect(parsePluginVolumeImageId(`${PLUGIN_VOLUME_SCHEME}:#3`)).toBeNull();
  });

  it("トークンに `#` が入っても最後の `#` で切る", () => {
    expect(parsePluginVolumeImageId(`${PLUGIN_VOLUME_SCHEME}:a#b#2`)).toEqual({ token: "a#b", z: 2 });
  });
});

describe("createValueStack", () => {
  it("スライス数ぶんの imageId を返し、セッションを持つ", () => {
    const before = valueStackCount();
    const { token, imageIds } = createValueStack({
      pluginId: "p",
      data: data(),
      dims: DIMS,
      nativeIds,
    });
    expect(imageIds).toHaveLength(DIMS[2]);
    expect(valueStackCount()).toBe(before + 1);
    expect(parsePluginVolumeImageId(imageIds[1])).toEqual({ token, z: 1 });
    releaseValueStack(token);
    expect(valueStackCount()).toBe(before);
  });

  it("呼ぶたびに違うトークンになる（古い絵がキャッシュから出てこない）", () => {
    const a = createValueStack({ pluginId: "p", data: data(), dims: DIMS, nativeIds });
    const b = createValueStack({ pluginId: "p", data: data(), dims: DIMS, nativeIds });
    expect(a.token).not.toBe(b.token);
    releaseValueStack(a.token);
    releaseValueStack(b.token);
  });

  it("🔴 参照スタックの枚数が合わなければ拒否する（黙って合わせない）", () => {
    expect(() =>
      createValueStack({ pluginId: "p", data: data(), dims: DIMS, nativeIds: ["only-one"] }),
    ).toThrow(/line up 1:1/);
  });

  it("データ長や dims が合わなければ拒否する", () => {
    expect(() =>
      createValueStack({ pluginId: "p", data: new Float32Array(5), dims: DIMS, nativeIds }),
    ).toThrow(/data length/);
    expect(() =>
      createValueStack({ pluginId: "p", data: data(), dims: [0, 3, 2], nativeIds }),
    ).toThrow(/bad dims/);
  });

  it("知らないトークンの release は何もしない", () => {
    const before = valueStackCount();
    releaseValueStack("nope");
    expect(valueStackCount()).toBe(before);
  });
});

describe("autoWindow", () => {
  it("上下 1% を落とした範囲にする（外れ値でレンジを決めない）", () => {
    const v = new Float32Array(1000);
    for (let i = 0; i < v.length; i++) v[i] = i;
    v[0] = -1e6;
    v[999] = 1e6;
    const w = autoWindow(v);
    // 外れ値をそのまま使うと中心 0・幅 2e6 になり、ほぼ全面が中間色になる。
    expect(w.width).toBeLessThan(2000);
    expect(w.center).toBeGreaterThan(0);
    expect(w.center).toBeLessThan(1000);
  });

  it("有限値が無ければ潰れない値を返す（幅 0 で割らない）", () => {
    const w = autoWindow(Float32Array.from([NaN, NaN]));
    expect(w.width).toBeGreaterThan(0);
  });

  it("一様なボリュームでも幅が 0 にならない", () => {
    const w = autoWindow(new Float32Array(100).fill(7));
    expect(w.width).toBeGreaterThan(0);
    expect(w.center).toBe(7);
  });
});

describe("一時シリーズ（transient）のセッション", () => {
  // 元の DWI のスライスを模したメタデータ。委譲されると**元の素性が見える**ことを使って、上書きの有無を判定する。
  const NATIVE = ["native:s0", "native:s1"];
  const native: Record<string, Record<string, unknown>> = {
    sopCommonModule: { sopInstanceUID: "1.2.DWI.SOP", sopClassUID: "1.2.840.10008.5.1.4.1.1.4" },
    generalSeriesModule: { seriesInstanceUID: "1.2.DWI.SERIES", seriesDescription: "DWI b1000", modality: "MR" },
    voiLutModule: { windowCenter: [500], windowWidth: [1000] },
    imagePlaneModule: { rowPixelSpacing: 2, columnPixelSpacing: 2 },
  };
  metaData.addProvider((type: string, imageId: string) => (NATIVE.includes(imageId) ? native[type] : undefined), 5);
  registerPluginVolumeLoader();
  const win = { center: 1.5, width: 3 };
  const tr = (c: number) => ({ seriesUid: "2.25.1234", description: "[Plugin X] ADC（未保存）", c });

  it("window 無しの transient は拒否する（元の DWI の窓が当たるのを防ぐ）", () => {
    expect(() =>
      createValueStack({ pluginId: "p", data: data(), dims: DIMS, nativeIds: NATIVE, transient: tr(0) }),
    ).toThrow(/window/);
  });

  it("transient: SOP・シリーズの素性・窓を、元の DWI に委譲せず自前で返す", () => {
    const { token, imageIds } = createValueStack({
      pluginId: "p", data: data(), dims: DIMS, nativeIds: NATIVE, unit: "mm2/s", window: win, transient: tr(2),
    });
    const sop = metaData.get("sopCommonModule", imageIds[1]) as { sopInstanceUID: string; sopClassUID: string };
    expect(sop.sopInstanceUID).toBe("2.25.1234.3.2"); // c=2 → 3、z=1 → 2
    expect(sop.sopInstanceUID).not.toBe("1.2.DWI.SOP");
    expect(sop.sopClassUID).toBe("1.2.840.10008.5.1.4.1.1.4"); // クラスは委譲
    const gs = metaData.get("generalSeriesModule", imageIds[0]) as Record<string, string>;
    expect(gs.seriesInstanceUID).toBe("2.25.1234");
    expect(gs.seriesDescription).toBe("[Plugin X] ADC（未保存）");
    expect(gs.modality).toBe("MR");
    const voi = metaData.get("voiLutModule", imageIds[0]) as { windowCenter: number[]; windowWidth: number[] };
    expect(voi).toEqual({ windowCenter: [1.5], windowWidth: [3] });
    const lut = metaData.get("modalityLutModule", imageIds[0]) as Record<string, unknown>;
    expect(lut).toEqual({ rescaleSlope: 1, rescaleIntercept: 0, rescaleType: "mm2/s" }); // 恒等＋単位
    releaseValueStack(token);
  });

  it("負例: 従来の mountViewport 用のセッションは今までどおり全部委譲する（回帰しない）", () => {
    const { token, imageIds } = createValueStack({ pluginId: "p", data: data(), dims: DIMS, nativeIds: NATIVE, window: win });
    expect((metaData.get("sopCommonModule", imageIds[0]) as { sopInstanceUID: string }).sopInstanceUID).toBe("1.2.DWI.SOP");
    expect((metaData.get("generalSeriesModule", imageIds[0]) as { seriesInstanceUID: string }).seriesInstanceUID).toBe("1.2.DWI.SERIES");
    releaseValueStack(token);
  });

  it("負例: 破棄したセッションの imageId は何も返さない", () => {
    const { token, imageIds } = createValueStack({
      pluginId: "p", data: data(), dims: DIMS, nativeIds: NATIVE, window: win, transient: tr(0),
    });
    releaseValueStack(token);
    expect(metaData.get("generalSeriesModule", imageIds[0])).toBeUndefined();
  });
});

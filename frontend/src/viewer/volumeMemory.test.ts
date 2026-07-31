/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_VOLUME_MAX_MB,
  MAX_VOLUME_MAX_MB,
  MIN_VOLUME_MAX_MB,
  findExceeding3dTextureDim,
  getAppliedVolumeMaxMb,
  getMax3dTextureSize,
  isCacheSizeExceeded,
  normalizeVolumeMaxMb,
  projectVolumeBytes,
  setAppliedVolumeMaxMb,
  volumeBudgetFromTotalMemory,
  volumeBytesPerVoxel,
  volumeCopyCount,
  volumeMaxBytes,
  VOLUME_BUDGET_SAFETY_RATIO,
  VolumeMemoryExceededError,
  type PixelFormatLike,
} from "./volumeMemory";

describe("normalizeVolumeMaxMb", () => {
  it("有効な数値はそのまま（文字列の設定値も受ける）", () => {
    expect(normalizeVolumeMaxMb(4096)).toBe(4096);
    // backend の設定 KV は常に文字列で返る。
    expect(normalizeVolumeMaxMb("4096")).toBe(4096);
    expect(normalizeVolumeMaxMb(" 512 ")).toBe(512);
  });

  it("境界値は許容する", () => {
    expect(normalizeVolumeMaxMb(MIN_VOLUME_MAX_MB)).toBe(MIN_VOLUME_MAX_MB);
    expect(normalizeVolumeMaxMb(MAX_VOLUME_MAX_MB)).toBe(MAX_VOLUME_MAX_MB);
  });

  it("範囲外・非数・未設定は既定値に倒す（壊れた設定で起動を止めない）", () => {
    expect(normalizeVolumeMaxMb(MIN_VOLUME_MAX_MB - 1)).toBe(DEFAULT_VOLUME_MAX_MB);
    expect(normalizeVolumeMaxMb(MAX_VOLUME_MAX_MB + 1)).toBe(DEFAULT_VOLUME_MAX_MB);
    expect(normalizeVolumeMaxMb(0)).toBe(DEFAULT_VOLUME_MAX_MB);
    expect(normalizeVolumeMaxMb(-1)).toBe(DEFAULT_VOLUME_MAX_MB);
    expect(normalizeVolumeMaxMb(NaN)).toBe(DEFAULT_VOLUME_MAX_MB);
    expect(normalizeVolumeMaxMb(Infinity)).toBe(DEFAULT_VOLUME_MAX_MB);
    expect(normalizeVolumeMaxMb("abc")).toBe(DEFAULT_VOLUME_MAX_MB);
    expect(normalizeVolumeMaxMb("")).toBe(DEFAULT_VOLUME_MAX_MB);
    expect(normalizeVolumeMaxMb(undefined)).toBe(DEFAULT_VOLUME_MAX_MB);
    expect(normalizeVolumeMaxMb(null)).toBe(DEFAULT_VOLUME_MAX_MB);
  });

  it("小数は切り捨てる", () => {
    expect(normalizeVolumeMaxMb(1024.9)).toBe(1024);
  });
});

describe("volumeMaxBytes", () => {
  it("MB をバイトに変換する", () => {
    expect(volumeMaxBytes(1024)).toBe(1024 * 1024 * 1024);
  });

  it("不正値は既定値のバイト数になる", () => {
    expect(volumeMaxBytes(NaN)).toBe(DEFAULT_VOLUME_MAX_MB * 1024 * 1024);
  });

  it("cornerstone の setMaxCacheSize が拒否する値（0/非数）を返さない", () => {
    // cache.setMaxCacheSize は falsy か非 number を throw する。
    for (const v of [0, -1, NaN, "abc", undefined]) {
      const b = volumeMaxBytes(v as number);
      expect(typeof b).toBe("number");
      expect(b).toBeGreaterThan(0);
    }
  });
});

describe("volumeBudgetFromTotalMemory", () => {
  const GB = 1024 * 1024 * 1024;

  it("実搭載量 × 安全率（40%）を MB で返す", () => {
    expect(volumeBudgetFromTotalMemory(16 * GB)).toBe(Math.floor(16 * 1024 * 0.4)); // 6553
    expect(volumeBudgetFromTotalMemory(8 * GB)).toBe(Math.floor(8 * 1024 * 0.4)); // 3276
  });

  it("低メモリ機では既定値(2048MB)より小さくなる（そこが狙い）", () => {
    expect(volumeBudgetFromTotalMemory(4 * GB)).toBeLessThan(DEFAULT_VOLUME_MAX_MB);
  });

  it("設定の範囲に丸める", () => {
    expect(volumeBudgetFromTotalMemory(1024)).toBe(MIN_VOLUME_MAX_MB);
    expect(volumeBudgetFromTotalMemory(1024 * GB)).toBe(MAX_VOLUME_MAX_MB);
  });

  it("取得できない（0・非有限）なら既定値", () => {
    expect(volumeBudgetFromTotalMemory(0)).toBe(DEFAULT_VOLUME_MAX_MB);
    expect(volumeBudgetFromTotalMemory(-1)).toBe(DEFAULT_VOLUME_MAX_MB);
    expect(volumeBudgetFromTotalMemory(NaN)).toBe(DEFAULT_VOLUME_MAX_MB);
  });

  it("安全率は 0.5 未満（GPU プロセス・backend と同居するため）", () => {
    expect(VOLUME_BUDGET_SAFETY_RATIO).toBeLessThan(0.5);
    expect(VOLUME_BUDGET_SAFETY_RATIO).toBeGreaterThan(0);
  });
});

describe("適用済み上限の記録", () => {
  beforeEach(() => setAppliedVolumeMaxMb(DEFAULT_VOLUME_MAX_MB));

  it("設定前は既定値を返す", () => {
    expect(getAppliedVolumeMaxMb()).toBe(DEFAULT_VOLUME_MAX_MB);
  });

  it("適用値を記録して読み戻せる", () => {
    setAppliedVolumeMaxMb(512);
    expect(getAppliedVolumeMaxMb()).toBe(512);
  });

  it("不正値を記録しようとしても既定値に丸められる", () => {
    setAppliedVolumeMaxMb(NaN);
    expect(getAppliedVolumeMaxMb()).toBe(DEFAULT_VOLUME_MAX_MB);
  });
});

describe("isCacheSizeExceeded", () => {
  it("cornerstone の実際のメッセージを識別する", () => {
    // cache.js: throw new Error(Events.CACHE_SIZE_EXCEEDED) — 値は大文字スネークケース。
    expect(isCacheSizeExceeded(new Error("CACHE_SIZE_EXCEEDED"))).toBe(true);
    // volumeLoader.js: createLocalVolume（CT チルト補正経路）。原文の typo 込み。
    expect(
      isCacheSizeExceeded(
        new Error("Cannot created derived volume: Volume with id vol-1 is not cacheable."),
      ),
    ).toBe(true);
  });

  it("将来のキャメルケース化にも耐える", () => {
    expect(isCacheSizeExceeded(new Error("cacheSizeExceeded"))).toBe(true);
  });

  it("Error 以外（文字列・throw された値）でも判定する", () => {
    expect(isCacheSizeExceeded("CACHE_SIZE_EXCEEDED")).toBe(true);
  });

  it("メッセージに埋め込まれていても拾う", () => {
    expect(isCacheSizeExceeded(new Error("MPR failed: CACHE_SIZE_EXCEEDED"))).toBe(true);
  });

  it("無関係な例外は false", () => {
    expect(isCacheSizeExceeded(new Error("Cannot create proxy with a non-object"))).toBe(false);
    expect(isCacheSizeExceeded(new Error("Network error"))).toBe(false);
    expect(isCacheSizeExceeded(null)).toBe(false);
    expect(isCacheSizeExceeded(undefined)).toBe(false);
  });
});

describe("volumeBytesPerVoxel", () => {
  const pf = (o: Partial<PixelFormatLike>): PixelFormatLike => ({
    bitsAllocated: 16,
    pixelRepresentation: 0,
    samplesPerPixel: 1,
    rescaleSlope: 1,
    rescaleIntercept: 0,
    ...o,
  });

  it("8bit は 1 バイト", () => {
    expect(volumeBytesPerVoxel(pf({ bitsAllocated: 8 }))).toBe(1);
  });

  it("CT（signed / intercept -1024）は Int16Array で 2 バイト", () => {
    expect(
      volumeBytesPerVoxel(pf({ pixelRepresentation: 1, rescaleSlope: 1, rescaleIntercept: -1024 })),
    ).toBe(2);
  });

  it("unsigned・負の rescale 無しは Uint16Array で 2 バイト", () => {
    expect(volumeBytesPerVoxel(pf({}))).toBe(2);
  });

  it("🚨 PET の非整数 RescaleSlope は 16bit でも Float32Array で 4 バイト", () => {
    // BitsAllocated だけで判断すると 2 倍見誤る箇所。
    expect(volumeBytesPerVoxel(pf({ rescaleSlope: 0.0123 }))).toBe(4);
  });

  it("非整数の RescaleIntercept でも 4 バイトになる", () => {
    expect(volumeBytesPerVoxel(pf({ rescaleIntercept: -1024.5 }))).toBe(4);
  });

  it("24bit は 1 バイト、32bit は 4 バイト", () => {
    expect(volumeBytesPerVoxel(pf({ bitsAllocated: 24 }))).toBe(1);
    expect(volumeBytesPerVoxel(pf({ bitsAllocated: 32 }))).toBe(4);
  });

  it("未知の BitsAllocated・未取得は null（予測しない）", () => {
    expect(volumeBytesPerVoxel(pf({ bitsAllocated: 12 }))).toBe(null);
    expect(volumeBytesPerVoxel(null)).toBe(null);
    expect(volumeBytesPerVoxel(undefined)).toBe(null);
  });
});

describe("volumeCopyCount", () => {
  it("MPR は非 CT が ×1、CT はチルト補正の可能性を見て ×2（保守側）", () => {
    expect(volumeCopyCount("mpr", "MR")).toBe(1);
    expect(volumeCopyCount("mpr", "CT")).toBe(2);
    expect(volumeCopyCount("mpr", "ct")).toBe(2);
    expect(volumeCopyCount("mpr", null)).toBe(1);
  });

  it("3D は vtk 用フルコピーの分だけ 1 本増える", () => {
    expect(volumeCopyCount("viewer3d", "MR")).toBe(2);
    expect(volumeCopyCount("viewer3d", "CT")).toBe(3);
  });
});

describe("projectVolumeBytes", () => {
  const ctPf: PixelFormatLike = {
    bitsAllocated: 16,
    pixelRepresentation: 1,
    samplesPerPixel: 1,
    rescaleSlope: 1,
    rescaleIntercept: -1024,
  };
  const args = {
    imageWidth: 512,
    imageHeight: 512,
    sliceCount: 400,
    pixelFormat: ctPf,
    modality: "CT",
  };
  // 512×512×400 の CT（2B/voxel）= 210MB（設計書 §2.4 の見積り例）。
  const volumeMb = (512 * 512 * 400 * 2) / (1024 * 1024);

  it("設計書 §2.4 の MPR（CT チルト補正あり）の見積りと一致する", () => {
    // volume ×2 ＋ image キャッシュ ＝ 3 本ぶん ≒ 630MB。
    const p = projectVolumeBytes({ ...args, target: "mpr" })!;
    expect(p.copies).toBe(2);
    expect(p.mb).toBe(Math.ceil(volumeMb * 3));
  });

  it("設計書 §2.4 の 3D の見積りと一致する", () => {
    // volume ×2 ＋ vtk コピー ＋ image キャッシュ ＝ 4 本ぶん ≒ 840MB。
    const p = projectVolumeBytes({ ...args, target: "viewer3d" })!;
    expect(p.copies).toBe(3);
    expect(p.mb).toBe(Math.ceil(volumeMb * 4));
  });

  it("チルト補正が無い（非 CT）なら volume ＋ image キャッシュの 2 本ぶん", () => {
    const p = projectVolumeBytes({ ...args, modality: "MR", target: "mpr" })!;
    expect(p.copies).toBe(1);
    expect(p.mb).toBe(Math.ceil(volumeMb * 2));
  });

  it("SamplesPerPixel（RGB）を掛ける", () => {
    const rgb: PixelFormatLike = {
      bitsAllocated: 8,
      pixelRepresentation: 0,
      samplesPerPixel: 3,
      rescaleSlope: 1,
      rescaleIntercept: 0,
    };
    const p = projectVolumeBytes({
      imageWidth: 100,
      imageHeight: 100,
      sliceCount: 10,
      pixelFormat: rgb,
      target: "mpr",
      modality: "OT",
    })!;
    expect(p.bytes).toBe(100 * 100 * 10 * 1 * 3 * 2);
  });

  it("寸法やピクセル形式が欠けていれば null（予測せず V1 のエラー識別に委ねる）", () => {
    expect(projectVolumeBytes({ ...args, target: "mpr", imageWidth: 0 })).toBe(null);
    expect(projectVolumeBytes({ ...args, target: "mpr", imageHeight: 0 })).toBe(null);
    expect(projectVolumeBytes({ ...args, target: "mpr", sliceCount: 0 })).toBe(null);
    expect(projectVolumeBytes({ ...args, target: "mpr", pixelFormat: null })).toBe(null);
  });
});

describe("VolumeMemoryExceededError", () => {
  it("isCacheSizeExceeded が true を返す（利用者から見れば同じ事象）", () => {
    expect(isCacheSizeExceeded(new VolumeMemoryExceededError(3e9, 2e9))).toBe(true);
  });

  it("必要量と上限を MB でメッセージに含む", () => {
    const e = new VolumeMemoryExceededError(3 * 1024 * 1024 * 1024, 2 * 1024 * 1024 * 1024);
    expect(e.message).toContain("3072MB");
    expect(e.message).toContain("2048MB");
  });
});

describe("findExceeding3dTextureDim", () => {
  it("上限内なら null", () => {
    expect(findExceeding3dTextureDim([512, 512, 400], 2048)).toBe(null);
    // 境界（ちょうど上限）は超過ではない。
    expect(findExceeding3dTextureDim([2048, 512, 400], 2048)).toBe(null);
  });

  it("超過している次元を返す", () => {
    expect(findExceeding3dTextureDim([512, 512, 2049], 2048)).toBe(2049);
  });

  it("複数超過していれば最大のものを返す（案内に最悪値を出すため）", () => {
    expect(findExceeding3dTextureDim([4096, 512, 3000], 2048)).toBe(4096);
  });

  it("上限が取得できない（null）なら判定しない", () => {
    expect(findExceeding3dTextureDim([9999, 9999, 9999], null)).toBe(null);
  });

  it("不正な上限値では判定しない（誤検知でボリュームを止めない）", () => {
    expect(findExceeding3dTextureDim([9999], 0)).toBe(null);
    expect(findExceeding3dTextureDim([9999], -1)).toBe(null);
    expect(findExceeding3dTextureDim([9999], NaN)).toBe(null);
  });

  it("寸法が空・未取得なら null", () => {
    expect(findExceeding3dTextureDim([], 2048)).toBe(null);
    expect(findExceeding3dTextureDim(null, 2048)).toBe(null);
    expect(findExceeding3dTextureDim(undefined, 2048)).toBe(null);
  });

  it("非数の混入は無視する", () => {
    expect(findExceeding3dTextureDim([NaN, 512, 512], 2048)).toBe(null);
  });

  it("TypedArray（vtk の getDimensions 戻り）でも動く", () => {
    expect(findExceeding3dTextureDim(Int32Array.from([512, 512, 4096]), 2048)).toBe(4096);
  });
});

describe("getMax3dTextureSize", () => {
  it("WebGL が無い環境（node）では null を返し、例外を投げない", () => {
    expect(getMax3dTextureSize()).toBe(null);
  });
});

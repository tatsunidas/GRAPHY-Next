/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_VOLUME_MAX_MB,
  MAX_VOLUME_MAX_MB,
  MIN_VOLUME_MAX_MB,
  getAppliedVolumeMaxMb,
  isCacheSizeExceeded,
  normalizeVolumeMaxMb,
  setAppliedVolumeMaxMb,
  volumeMaxBytes,
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

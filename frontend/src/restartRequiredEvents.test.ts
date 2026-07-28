/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearRestartRequired,
  markRestartRequired,
  restartRequiredReason,
} from "./restartRequiredEvents";

/**
 * 再起動バナーの理由付け。DICOM 設定とプラグイン導入で文言が変わるため、保存値の解釈を固定する。
 * とくに解除の合図 "0" を理由と取り違えると、再起動が不要なのにバナーが出続ける。
 *
 * <p>vitest は environment:"node" のため localStorage が無い。jsdom を足さずに済むよう、
 * 最小のスタブを置く（BroadcastChannel は実装側が例外を握り潰すので不要）。
 */
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

describe("restartRequiredEvents", () => {
  beforeEach(() => {
    store.clear();
  });

  it("既定は DICOM 設定の変更として記録する", () => {
    markRestartRequired();
    expect(restartRequiredReason()).toBe("dicom");
  });

  it("プラグイン由来を区別して記録する", () => {
    markRestartRequired("plugin");
    expect(restartRequiredReason()).toBe("plugin");
  });

  it("未設定なら要求なし", () => {
    expect(restartRequiredReason()).toBeNull();
  });

  it("解除すると要求なしに戻る", () => {
    markRestartRequired("plugin");
    clearRestartRequired();
    expect(restartRequiredReason()).toBeNull();
  });

  it("旧形式 \"1\" は DICOM として扱う（後方互換）", () => {
    localStorage.setItem("graphy-restart-required", "1");
    expect(restartRequiredReason()).toBe("dicom");
  });

  it("解除の合図 \"0\" を理由と誤解しない", () => {
    localStorage.setItem("graphy-restart-required", "0");
    expect(restartRequiredReason()).toBeNull();
  });
});

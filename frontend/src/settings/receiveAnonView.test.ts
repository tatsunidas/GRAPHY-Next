/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  barView, buildBody, hiddenOptions, MAX_PREFIX, rejectReasonKey, validateForm,
  type ReceiveAnonProfile, type ReceiveAnonView,
} from "./receiveAnonView";

const view = (over: Partial<ReceiveAnonView["status"]> = {}, enabled = true): ReceiveAnonView => ({
  enabled,
  profile: null,
  status: {
    enabled, profileValid: true, keyCreatedAt: null, keyCreatedThisRun: false,
    accepted: 3, rejected: 0, recentRejections: [], ...over,
  },
});

describe("barView", () => {
  it("取得できない（web モードの 404）・無効のときは出さない", () => {
    expect(barView(null).visible).toBe(false);
    expect(barView(view({}, false)).visible).toBe(false);
  });
  it("有効なら件数つきで出す", () => {
    expect(barView(view())).toEqual({ visible: true, tone: "ok", accepted: 3, rejected: 0 });
  });
  it("拒否があれば warn、プロファイル不正なら error（不正が優先）", () => {
    expect(barView(view({ rejected: 2 })).tone).toBe("warn");
    expect(barView(view({ rejected: 2, profileValid: false })).tone).toBe("error");
  });
});

describe("rejectReasonKey", () => {
  it("固定コードを対応するキーにし、未知は汎用", () => {
    expect(rejectReasonKey("burned-in-annotation")).toBe("recvAnon.reason.burned");
    expect(rejectReasonKey("burn-prone-modality")).toBe("recvAnon.reason.modality");
    expect(rejectReasonKey("failed:IOException")).toBe("recvAnon.reason.failed");
    expect(rejectReasonKey("something-else")).toBe("recvAnon.reason.unknown");
  });
});

describe("validateForm", () => {
  const ok = { enabled: true, wasEnabled: true, confirmed: false, prefix: "ANON-" };
  it("すでに有効なら確認なしで保存できる", () => {
    expect(validateForm(ok)).toBeNull();
  });
  it("無効→有効は確認が要る。確認済みなら通る", () => {
    expect(validateForm({ ...ok, wasEnabled: false })).toBe("recvAnon.err.confirm");
    expect(validateForm({ ...ok, wasEnabled: false, confirmed: true })).toBeNull();
  });
  it("無効のままなら確認は要らない", () => {
    expect(validateForm({ ...ok, enabled: false, wasEnabled: false })).toBeNull();
  });
  it("接頭辞は上限ちょうどまで。1 文字超えると落ちる", () => {
    expect(validateForm({ ...ok, prefix: "A".repeat(MAX_PREFIX) })).toBeNull();
    expect(validateForm({ ...ok, prefix: "A".repeat(MAX_PREFIX + 1) })).toBe("recvAnon.err.prefixLong");
  });
});

describe("buildBody", () => {
  const base: ReceiveAnonProfile = {
    options: ["RetainSafePrivate", "CleanPixelData"],
    patientIdPrefix: "X-",
    patientName: null,
    manualRetainTags: ["00091001"],
    customReplacements: { "00080080": "Z" },
  };
  it("画面に出さない項目（非表示のオプション・保持タグ・置換）をそのまま送り返す", () => {
    expect(hiddenOptions(base.options)).toEqual(["CleanPixelData"]);
    const b = buildBody(base, ["CleanDescriptors"], "ANON-", "");
    expect(b.options).toEqual(["CleanDescriptors", "CleanPixelData"]);
    expect(b.manualRetainTags).toEqual(["00091001"]);
    expect(b.customReplacements).toEqual({ "00080080": "Z" });
  });
  it("接頭辞が空なら既定、患者名が空白なら null", () => {
    const b = buildBody(null, [], "", "  ");
    expect(b.patientIdPrefix).toBe("ANON-");
    expect(b.patientName).toBeNull();
    expect(b.manualRetainTags).toEqual([]);
  });
});

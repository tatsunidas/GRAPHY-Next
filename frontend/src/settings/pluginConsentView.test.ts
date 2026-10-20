/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { PluginPreview } from "../plugins/pluginManagerApi";
import { canConfirmInstall, needsUnverifiedAck, signatureBlocks } from "./pluginConsentView";

type P = Pick<PluginPreview, "integrityVerified" | "installable" | "signature">;
const p = (over: Partial<P> = {}): P => ({ integrityVerified: true, installable: true, signature: "first-use", ...over });

describe("canConfirmInstall", () => {
  it("正例: 互換 OK・完全性 OK なら、署名が first-use / pinned / trusted でも押せる", () => {
    for (const signature of ["first-use", "pinned", "trusted"] as const) {
      expect(canConfirmInstall(p({ signature }), false, false)).toBe(true);
    }
  });
  it("負例: 署名が invalid なら、承知のチェックを入れても押せない", () => {
    expect(canConfirmInstall(p({ signature: "invalid" }), false, false)).toBe(false);
    expect(canConfirmInstall(p({ signature: "invalid" }), true, false)).toBe(false);
    expect(canConfirmInstall(p({ signature: "invalid", integrityVerified: false }), true, false)).toBe(false);
  });
  it("負例: 互換 NG・処理中は従来どおり押せない", () => {
    expect(canConfirmInstall(p({ installable: false }), true, false)).toBe(false);
    expect(canConfirmInstall(p(), false, true)).toBe(false);
  });
  it("署名なしは完全性を確認できないときだけ承知のチェックが要る（従来どおり）", () => {
    expect(canConfirmInstall(p({ signature: "unsigned", integrityVerified: false }), false, false)).toBe(false);
    expect(canConfirmInstall(p({ signature: "unsigned", integrityVerified: false }), true, false)).toBe(true);
    expect(canConfirmInstall(p({ signature: "unsigned" }), false, false)).toBe(true);
  });
});

describe("signatureBlocks / needsUnverifiedAck", () => {
  it("invalid だけが導入を妨げる", () => {
    expect(signatureBlocks({ signature: "invalid" })).toBe(true);
    for (const s of ["trusted", "pinned", "first-use", "unsigned"] as const) expect(signatureBlocks({ signature: s })).toBe(false);
  });
  it("導入できない配布物には承知のチェックを出さない", () => {
    expect(needsUnverifiedAck(p({ signature: "invalid", integrityVerified: false }))).toBe(false);
    expect(needsUnverifiedAck(p({ installable: false, integrityVerified: false }))).toBe(false);
    expect(needsUnverifiedAck(p({ integrityVerified: false }))).toBe(true);
  });
});

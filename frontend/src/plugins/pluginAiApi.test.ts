/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 外部送信ゲートの回帰テスト（fw/art-of-imaging-design.md §3）。
 *
 * <p>ここで守りたいのは「同意ダイアログの見た目」ではなく、**同意へ到達する前に
 * 落ちるべきものが落ちること**。権限を宣言していないプラグインや鍵が無い状態で
 * `aiGenerate` が呼ばれてしまうと、その時点で患者画素が外へ出る。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestAiGeneration, forgetAiConsents, AI_EGRESS_PERMISSION } from "./pluginAiApi";
import type { PluginManifest } from "./pluginTypes";

const IMAGE = new Uint8Array([1, 2, 3, 4]);

function manifest(permissions?: string[]): PluginManifest {
  return { id: "art", name: "Art of Imaging", version: "0.1.0", permissions };
}

/** Electron の preload が入れるオブジェクトを最小限だけ真似る。 */
function installBridge(over: Record<string, unknown> = {}): {
  aiGenerate: ReturnType<typeof vi.fn>;
  secretStatus: ReturnType<typeof vi.fn>;
} {
  const aiGenerate = vi.fn(async () => ({ ok: true, data: {} }));
  const secretStatus = vi.fn(async () => ({ hasValue: true, persisted: true, encryptionAvailable: true }));
  (globalThis as unknown as { window: unknown }).window = {
    graphyDesktop: { aiGenerate, secretStatus, ...over },
  };
  return { aiGenerate, secretStatus };
}

const base = { model: "gemini-3.1-flash-image", prompt: "p", imageBytes: IMAGE };

describe("requestAiGeneration — 送信前に落ちるべきもの", () => {
  beforeEach(() => {
    forgetAiConsents();
    (globalThis as unknown as { window?: unknown }).window = undefined;
  });

  it("ai-egress 未宣言なら送信せずに拒否する", async () => {
    const { aiGenerate } = installBridge();
    const r = await requestAiGeneration({ ...base, manifest: manifest(["read-pixels"]) });
    expect(r).toEqual({ ok: false, error: "permission-denied" });
    // 🔴 「拒否した」だけでなく、**一度も呼ばれていない**ことを見る。
    expect(aiGenerate).not.toHaveBeenCalled();
  });

  it("permissions が未定義でも拒否する（宣言が無いことを許可と読まない）", async () => {
    const { aiGenerate } = installBridge();
    const r = await requestAiGeneration({ ...base, manifest: manifest(undefined) });
    expect(r).toEqual({ ok: false, error: "permission-denied" });
    expect(aiGenerate).not.toHaveBeenCalled();
  });

  it("API キーが無ければ、同意を求める前に止まる", async () => {
    const { aiGenerate } = installBridge({
      secretStatus: vi.fn(async () => ({ hasValue: false, persisted: false, encryptionAvailable: true })),
    });
    const r = await requestAiGeneration({ ...base, manifest: manifest([AI_EGRESS_PERMISSION]) });
    expect(r).toEqual({ ok: false, error: "no-api-key" });
    expect(aiGenerate).not.toHaveBeenCalled();
  });

  it("デスクトップ以外（web モード）では送信経路が無いことをそのまま返す", async () => {
    (globalThis as unknown as { window: unknown }).window = {};
    const r = await requestAiGeneration({ ...base, manifest: manifest([AI_EGRESS_PERMISSION]) });
    expect(r).toEqual({ ok: false, error: "desktop-only" });
  });

  it("権限と鍵が揃っていても、同意が済むまでは送信しない", async () => {
    const { aiGenerate } = installBridge();
    let settled = false;
    const p = requestAiGeneration({
      ...base,
      manifest: manifest([AI_EGRESS_PERMISSION]),
      scopeKey: "1.2.3",
    }).then((r) => {
      settled = true;
      return r;
    });
    // 同意ダイアログはホストコンポーネントが描くもので、このテスト環境には居ない。
    // よって promise は宙に浮いたままになる ＝ 送信も起きない、が確かめたいこと。
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(aiGenerate).not.toHaveBeenCalled();
    void p;
  });
});

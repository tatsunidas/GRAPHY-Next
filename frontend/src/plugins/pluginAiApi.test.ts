/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 外部送信の renderer 側（fw/art-of-imaging-design.md §3）。同意・監査・宛先の確認は main の
 * `aiEgressGate`（desktop/aiEgressGate.test.js）。ここでは、権限の早期確認・自己申告の添付・
 * main の結果の扱いを見る。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestAiGeneration, AI_EGRESS_PERMISSION } from "./pluginAiApi";
import type { PluginManifest } from "./pluginTypes";

const IMAGE = new Uint8Array([1, 2, 3, 4]);

function manifest(permissions?: string[]): PluginManifest {
  return { id: "art", name: "Art of Imaging", version: "0.1.0", permissions };
}

function installBridge(result: Record<string, unknown> = { ok: true }) {
  const aiGenerate = vi.fn(async (_req: unknown) => result);
  (globalThis as unknown as { window: unknown }).window = { graphyDesktop: { aiGenerate } };
  return { aiGenerate };
}

const base = { prompt: "p", imageBytes: IMAGE };

describe("requestAiGeneration — 送信前に落ちるべきもの", () => {
  beforeEach(() => {
    (globalThis as unknown as { window?: unknown }).window = undefined;
  });

  it("ai-egress 未宣言なら main を呼ばずに拒否する", async () => {
    const { aiGenerate } = installBridge();
    const r = await requestAiGeneration({ ...base, manifest: manifest(["read-pixels"]) });
    expect(r).toEqual({ ok: false, error: "permission-denied" });
    expect(aiGenerate).not.toHaveBeenCalled();
  });

  it("permissions が未定義でも拒否する（宣言が無いことを許可と読まない）", async () => {
    const { aiGenerate } = installBridge();
    const r = await requestAiGeneration({ ...base, manifest: manifest(undefined) });
    expect(r).toEqual({ ok: false, error: "permission-denied" });
    expect(aiGenerate).not.toHaveBeenCalled();
  });

  it("デスクトップ以外（web モード）では送信経路が無いことをそのまま返す", async () => {
    (globalThis as unknown as { window: unknown }).window = {};
    const r = await requestAiGeneration({ ...base, manifest: manifest([AI_EGRESS_PERMISSION]) });
    expect(r).toEqual({ ok: false, error: "desktop-only" });
  });
});

describe("requestAiGeneration — main へ渡すもの", () => {
  beforeEach(() => {
    (globalThis as unknown as { window?: unknown }).window = undefined;
  });

  it("用途・自己申告の pluginId・scopeKey・画像(base64)を渡す", async () => {
    const { aiGenerate } = installBridge();
    await requestAiGeneration({ ...base, manifest: manifest([AI_EGRESS_PERMISSION]), capability: "image-to-text", scopeKey: "1.2.3" });
    expect(aiGenerate).toHaveBeenCalledTimes(1);
    expect(aiGenerate.mock.calls[0][0]).toMatchObject({
      capability: "image-to-text",
      claimedPluginId: "art",
      scopeKey: "1.2.3",
      imageBase64: "AQIDBA==",
      prompt: "p",
    });
  });

  it("用途の既定は image-to-image", async () => {
    const { aiGenerate } = installBridge();
    await requestAiGeneration({ ...base, manifest: manifest([AI_EGRESS_PERMISSION]) });
    expect(aiGenerate.mock.calls[0][0]).toMatchObject({ capability: "image-to-image" });
  });

  it("🔴 main の拒否(unknown-caller / canceled / no-api-key)はそのまま返る", async () => {
    for (const error of ["unknown-caller", "canceled", "no-api-key"]) {
      installBridge({ ok: false, error });
      const r = await requestAiGeneration({ ...base, manifest: manifest([AI_EGRESS_PERMISSION]) });
      expect(r).toEqual({ ok: false, error });
    }
  });
});

/**
 * 🚨 **2026-09-27 に実機で発覚した不具合の回帰試験。**
 *
 * 段 2 で「応答の正規化を本体へ移す」と決めたのに、`requestAiGeneration` は main の結果を
 * **素通し**していた。main が返すのは `image: { base64 }`、プラグインへの契約は
 * `image: { bytes: Uint8Array }`——プラグインは `.bytes` を読んで `undefined` を得るので、
 * **「画像が返らなかった」と表示していた**。
 *
 * 🔴 **なぜテストが捕まえなかったか**（同じ穴を作らないために書く）:
 *   1. ここの既存のテストは**すべて「送る前に止まる」経路**を見ていた。
 *      返ってきたものを読む行は 1 度も実行されていなかった
 *   2. `pluginTemplateTypes.test.ts` は `.d.ts` の**名前だけ**を見る作り
 *      （型の同一性までは見ない、と明記してある）
 *   3. 本体側の型は `AiGenerationOutcome = AiGenerateResult | …` という別名だったので、
 *      **契約とずれていても tsc は何も言わなかった**
 */
describe("requestAiGeneration — 返ってきたものの形（契約どおりか）", () => {
  beforeEach(() => {
    (globalThis as unknown as { window?: unknown }).window = undefined;
  });

  /** 画像を返す main を真似る。**main は base64 で返す。** */
  function bridgeReturning(result: Record<string, unknown>) {
    const aiGenerate = vi.fn(async (_req: unknown) => result);
    (globalThis as unknown as { window: unknown }).window = {
      graphyDesktop: { aiGenerate },
    };
    return { aiGenerate };
  }

  const letThrough = (opts: Parameters<typeof requestAiGeneration>[0]) => requestAiGeneration(opts);

  const req = (over: Record<string, unknown> = {}) => ({
    manifest: manifest([AI_EGRESS_PERMISSION]),
    prompt: "p",
    imageBytes: IMAGE,
    capability: "image-to-image" as const,
    ...over,
  });

  it("🔴 画像は Uint8Array で渡る（main の base64 をここで畳む）", async () => {
    // "PNG" の 4 バイト。
    bridgeReturning({ ok: true, image: { base64: "iVBORw==", mimeType: "image/png" } });
    const r = await letThrough(req());
    expect(r.ok).toBe(true);
    const image = (r as { image?: { bytes: Uint8Array; mimeType: string } }).image;
    expect(image?.bytes, "base64 を素通しにすると undefined になる").toBeInstanceOf(Uint8Array);
    expect(Array.from(image!.bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(image?.mimeType).toBe("image/png");
    // 素通しの名残（base64）を残さない。
    expect((image as unknown as { base64?: string }).base64).toBeUndefined();
  });

  it("文章・拒否理由・由来はそのまま渡る", async () => {
    bridgeReturning({
      ok: true, text: "説明", blockReason: undefined,
      provenance: { providerId: "g", kind: "gemini", model: "m", endpointHost: "g.test" },
      data: { raw: true },
    });
    const r = await letThrough(req({ capability: "image-to-text" }));
    expect(r).toMatchObject({
      ok: true,
      text: "説明",
      provenance: { providerId: "g", model: "m" },
      data: { raw: true },
    });
  });

  it("画像が無い応答では image を作らない（「無い」と「壊れた」を混ぜない）", async () => {
    bridgeReturning({ ok: true, blockReason: "SAFETY" });
    const r = await letThrough(req());
    expect(r).toEqual({ ok: true, blockReason: "SAFETY" });
  });

  it("🔴 壊れた base64 で例外を投げず、失敗として返す（提供元の応答を信用しない）", async () => {
    bridgeReturning({ ok: true, image: { base64: "これは base64 ではない！！", mimeType: "image/png" } });
    const r = await letThrough(req());
    expect(r).toEqual({ ok: false, error: "invalid-image" });
  });

  it("失敗はそのまま素通しする（余計に畳まない）", async () => {
    bridgeReturning({ ok: false, error: "empty-response", status: 200 });
    const r = await letThrough(req());
    expect(r).toEqual({ ok: false, error: "empty-response", status: 200 });
  });
});

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
import {
  requestAiGeneration,
  forgetAiConsents,
  peekAiConsent,
  settleAiConsent,
  AI_EGRESS_PERMISSION,
} from "./pluginAiApi";
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

// ── 用途 → 宛先の解決（設計: fw/ai-routing-design.md §4） ───────────────────
//
// 🔑 **解決は Electron main が行う。** レンダラは結果を受けて同意を出すだけ。
// ここが狂うと「同意画面に出した宛先と実際の宛先が違う」という形で壊れ、
// **利用者は気付けない**（画面には正しそうな宛先が出ている）。
describe("requestAiGeneration — 宛先は main が決める", () => {
  beforeEach(() => {
    forgetAiConsents();
    if (peekAiConsent()) settleAiConsent({ ok: false });
    (globalThis as unknown as { window?: unknown }).window = undefined;
  });

  /** main の解決結果を差し替える。 */
  function bridgeWithPlan(plan: Record<string, unknown>) {
    const aiGenerate = vi.fn(async (_req: unknown) => ({ ok: true }));
    const aiResolve = vi.fn(async (_c: unknown) => plan);
    (globalThis as unknown as { window: unknown }).window = {
      graphyDesktop: { aiGenerate, aiResolve, secretStatus: vi.fn(async () => ({ hasValue: true })) },
    };
    return { aiGenerate, aiResolve };
  }

  const ok = (over: Record<string, unknown> = {}) => ({
    manifest: manifest([AI_EGRESS_PERMISSION]),
    prompt: "p",
    imageBytes: IMAGE,
    ...over,
  });

  async function runWithConsent(opts: Parameters<typeof requestAiGeneration>[0]) {
    const p = requestAiGeneration(opts);
    for (let i = 0; i < 200 && !peekAiConsent(); i++) await Promise.resolve();
    const shown = peekAiConsent();
    if (shown) settleAiConsent({ ok: true, remember: false });
    const result = await p;
    return { shown: shown?.request, result };
  }

  it("解決した宛先とモデルがそのまま送信に使われる", async () => {
    const { aiGenerate, aiResolve } = bridgeWithPlan({
      ok: true, providerId: "azure-hosp", label: "院内", kind: "openai",
      model: "gpt-image-1", endpointHost: "xxx.openai.azure.com", hasApiKey: true,
    });

    await runWithConsent(ok({ capability: "image-to-image" }));
    expect(aiResolve).toHaveBeenCalledWith("image-to-image");
    expect(aiGenerate.mock.calls[0][0]).toMatchObject({ capability: "image-to-image", model: "gpt-image-1" });
  });

  it("🔴 同意ダイアログには解決後の宛先が出る（定数ではない）", async () => {
    bridgeWithPlan({
      ok: true, providerId: "azure-hosp", label: "院内", kind: "openai",
      model: "gpt-image-1", endpointHost: "xxx.openai.azure.com", hasApiKey: true,
    });

    const { shown } = await runWithConsent(ok({ capability: "image-to-image" }));
    expect(shown).toMatchObject({ host: "xxx.openai.azure.com", model: "gpt-image-1" });
  });

  it("🔴 扱える提供元が無ければ、同意を求める前に止まる", async () => {
    const { aiGenerate } = bridgeWithPlan({ ok: false, error: "no-provider-for-capability" });

    const r = await requestAiGeneration(ok({ capability: "image-to-image" }));
    expect(r).toEqual({ ok: false, error: "no-provider-for-capability" });
    expect(peekAiConsent()).toBeNull();
    expect(aiGenerate).not.toHaveBeenCalled();
  });

  it("🔴 鍵が無ければ、同意を求める前に止まる（提供元ごとに見る）", async () => {
    const { aiGenerate } = bridgeWithPlan({
      ok: true, providerId: "g", label: "G", kind: "gemini",
      model: "m", endpointHost: "h.test", hasApiKey: false,
    });

    const r = await requestAiGeneration(ok({ capability: "image-to-text" }));
    expect(r).toEqual({ ok: false, error: "no-api-key" });
    expect(peekAiConsent()).toBeNull();
    expect(aiGenerate).not.toHaveBeenCalled();
  });

  it("🔴 ある提供元への同意は、別の提供元への送信を許さない", async () => {
    const first = bridgeWithPlan({
      ok: true, providerId: "g1", label: "G1", kind: "gemini",
      model: "m", endpointHost: "g1.test", hasApiKey: true,
    });
    await runWithConsent(ok({ capability: "image-to-text", scopeKey: "series-1" }));
    expect(first.aiGenerate).toHaveBeenCalledTimes(1);

    // 同じプラグイン・同じシリーズだが、宛先が変わった。
    const second = bridgeWithPlan({
      ok: true, providerId: "g2", label: "G2", kind: "gemini",
      model: "m", endpointHost: "g2.test", hasApiKey: true,
    });
    const p = requestAiGeneration(ok({ capability: "image-to-text", scopeKey: "series-1" }));
    for (let i = 0; i < 200 && !peekAiConsent(); i++) await Promise.resolve();
    expect(peekAiConsent(), "別の提供元なら同意を出し直すこと").not.toBeNull();
    settleAiConsent({ ok: true, remember: false });
    await p;
    expect(second.aiGenerate).toHaveBeenCalledTimes(1);
  });

  it("aiResolve を持たない古い main では従来の宛先へ落ちる", async () => {
    const aiGenerate = vi.fn(async (_req: unknown) => ({ ok: true }));
    (globalThis as unknown as { window: unknown }).window = {
      graphyDesktop: { aiGenerate, secretStatus: vi.fn(async () => ({ hasValue: true })) },
    };
    const { shown } = await runWithConsent(ok({ capability: "image-to-text" }));
    expect(shown).toMatchObject({ host: "generativelanguage.googleapis.com", model: "gemini-2.5-flash" });
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
    forgetAiConsents();
    (globalThis as unknown as { window?: unknown }).window = undefined;
  });

  /** 画像を返す main を真似る。**main は base64 で返す。** */
  function bridgeReturning(result: Record<string, unknown>) {
    const aiGenerate = vi.fn(async (_req: unknown) => result);
    (globalThis as unknown as { window: unknown }).window = {
      graphyDesktop: { aiGenerate, secretStatus: vi.fn(async () => ({ hasValue: true })) },
    };
    return { aiGenerate };
  }

  async function letThrough(opts: Parameters<typeof requestAiGeneration>[0]) {
    const p = requestAiGeneration(opts);
    for (let i = 0; i < 200 && !peekAiConsent(); i++) await Promise.resolve();
    if (peekAiConsent()) settleAiConsent({ ok: true, remember: false });
    return p;
  }

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

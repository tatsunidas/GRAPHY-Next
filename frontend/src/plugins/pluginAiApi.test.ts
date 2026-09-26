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
  resetAiSettingsCache,
  peekAiConsent,
  settleAiConsent,
  AI_EGRESS_PERMISSION,
} from "./pluginAiApi";
import { fetchSettings } from "../settings/settingsApi";
import type { PluginManifest } from "./pluginTypes";

// 設定の取得はバックエンドへの往復なので差し替える（ここで見たいのはモデルの決まり方）。
vi.mock("../settings/settingsApi", () => ({ fetchSettings: vi.fn() }));

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

// ── 用途 → モデルの解決（設計: fw/ai-routing-design.md §2） ─────────────────
//
// 🔑 **プラグインはモデルも宛先も知らなくてよい。** 用途を頼めば本体が決める。
// ここが狂うと「画像生成の用途にテキストモデルが渡る」形で壊れ、**例外は出ずに
// 画像だけ返らない**ので気付きにくい。
describe("requestAiGeneration — 用途からモデルを決める", () => {
  beforeEach(() => {
    forgetAiConsents();
    resetAiSettingsCache();
    // 前のテストが残した同意待ちを捨てる（1 本しか出せないため、残ると次が即 false になる）。
    if (peekAiConsent()) settleAiConsent({ ok: false });
    vi.mocked(fetchSettings).mockReset();
  });

  /** 同意ダイアログを描く側の代わりに、出てきたら承諾する。 */
  async function runWithConsent(
    opts: Parameters<typeof requestAiGeneration>[0],
  ): Promise<{ model?: string; capability?: string }> {
    const p = requestAiGeneration(opts);
    for (let i = 0; i < 200 && !peekAiConsent(); i++) await Promise.resolve();
    const shown = peekAiConsent();
    if (shown) settleAiConsent({ ok: true, remember: false });
    await p;
    return (shown?.request ?? {}) as { model?: string; capability?: string };
  }

  const ok = (over: Record<string, unknown> = {}) => ({
    manifest: manifest([AI_EGRESS_PERMISSION]),
    prompt: "p",
    imageBytes: IMAGE,
    ...over,
  });

  it("用途ごとに別のモデルが選ばれる（画像用とテキスト用は別物）", async () => {
    const { aiGenerate } = installBridge();
    vi.mocked(fetchSettings).mockResolvedValue({});

    await runWithConsent(ok({ capability: "image-to-image" }));
    expect(aiGenerate.mock.calls[0][0]).toMatchObject({
      capability: "image-to-image",
      model: "gemini-3.1-flash-image",
    });

    await runWithConsent(ok({ capability: "image-to-text" }));
    expect(aiGenerate.mock.calls[1][0]).toMatchObject({
      capability: "image-to-text",
      model: "gemini-2.5-flash",
    });
  });

  it("🔴 環境設定のモデルが効く（従来は誰も読んでいなかった）", async () => {
    const { aiGenerate } = installBridge();
    vi.mocked(fetchSettings).mockResolvedValue({ "ai.gemini.model": "my-image-model" });

    await runWithConsent(ok({ capability: "image-to-image" }));
    expect(aiGenerate.mock.calls[0][0]).toMatchObject({ model: "my-image-model" });
  });

  it("モデルを名指ししてきた古いプラグインは、設定を見ずにそのまま通す", async () => {
    const { aiGenerate } = installBridge();
    vi.mocked(fetchSettings).mockResolvedValue({ "ai.gemini.model": "設定側" });

    await runWithConsent(ok({ model: "プラグイン指定" }));
    expect(aiGenerate.mock.calls[0][0]).toMatchObject({ model: "プラグイン指定" });
    expect(fetchSettings).not.toHaveBeenCalled();
  });

  it("設定が読めなくても既定で送れる（送信を止める理由にしない）", async () => {
    const { aiGenerate } = installBridge();
    vi.mocked(fetchSettings).mockRejectedValue(new Error("offline"));

    await runWithConsent(ok({ capability: "image-to-text" }));
    expect(aiGenerate.mock.calls[0][0]).toMatchObject({ model: "gemini-2.5-flash" });
  });

  it("🔴 同意ダイアログには、実際に使うモデルが出る", async () => {
    installBridge();
    vi.mocked(fetchSettings).mockResolvedValue({});

    const shown = await runWithConsent(ok({ capability: "image-to-text" }));
    expect(shown.model).toBe("gemini-2.5-flash");
  });
});

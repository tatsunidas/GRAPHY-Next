/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグインから外部 AI へ画像を送るための唯一の入口（fw/art-of-imaging-design.md §3）。
 *
 * <h3>ここが境界である理由</h3>
 * `desktopBridge` の `aiGenerate` を直接呼べば同意も監査も素通りできてしまう。
 * **プラグインへ渡すのはこのモジュールの `requestAiGeneration` だけ**で、ここが
 *   (1) `ai-egress` 権限の確認  (2) 鍵の有無の確認  (3) 送信前の同意  (4) 監査ログ
 * を順に通す。どれか 1 つでも欠けたら送らない。
 *
 * <h3>`ai-egress` は「実際に強制される」最初の権限</h3>
 * これまで `plugin.json` の `permissions` は宣言のみで、インストール時の一覧表示にしか
 * 使われていなかった（`PluginConsentDialog`）。患者画素が第三者クラウドへ出る操作は
 * 宣言だけでは足りないので、ここでは実行時に弾く。
 *
 * <h3>React の外から呼ばれる</h3>
 * プラグインの `ui.js` は本体のツリーの外に居るため、`createRoot` で独立したルートを
 * 立てると `useI18n must be used within I18nProvider` で落ちる
 * （`pluginSeriesPanelApi.tsx` に同じ轍がある）。そこで本体のツリーの中に置いた
 * {@link AiEgressConsentHost} が購読し、`createPortal` で body へ出す。
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { desktop, type AiGenerateResult } from "../desktopBridge";
import { log } from "../log";
import { AiEgressConsentDialog, type AiEgressRequest } from "./AiEgressConsentDialog";
import type { PluginManifest } from "./pluginTypes";
import { fetchSettings } from "../settings/settingsApi";
import type { AiCapability } from "../desktopBridge";

/** 送信先。UI に出す値であり、実際の接続は Electron main が行う。 */
export const AI_HOST = "generativelanguage.googleapis.com";
/**
 * 提供元の識別子。**同意を覚える単位に入る。**
 *
 * <p>段 3 で `ai-providers.json` から解決した値になる。いまは提供元が 1 つなので定数。
 */
export const AI_PROVIDER_ID = "gemini-public";
/** この権限を `plugin.json` の `permissions` に宣言していないプラグインは送信できない。 */
export const AI_EGRESS_PERMISSION = "ai-egress";
const SECRET_KEY = "ai.gemini.apiKey";

/**
 * 用途ごとの既定モデル。
 *
 * <p>🔑 **プラグインはモデルを知らなくてよい。** 用途を頼めば本体が決める
 * （設計: `fw/ai-routing-design.md` §2）。段 3 で `ai-providers.json` へ移る。
 *
 * <p>⚠ 画像生成用のモデルは文章を返さず、その逆も同様なので、**1 つの設定では両方を賄えない**。
 * 用途ごとに持つ必要がある。
 */
const DEFAULT_MODELS: Record<AiCapability, string> = {
  "image-to-image": "gemini-3.1-flash-image",
  "image-to-text": "gemini-2.5-flash",
};
/** 環境設定のキー。`image-to-image` 側は既存の設定（従来は**誰も読んでいなかった**）。 */
const MODEL_SETTING_KEYS: Record<AiCapability, string> = {
  "image-to-image": "ai.gemini.model",
  "image-to-text": "ai.gemini.textModel",
};
const API_VERSION_SETTING_KEY = "ai.gemini.apiVersion";

/** 設定は 1 セッション 1 回だけ読む（生成ごとに往復させない）。 */
let settingsCache: Record<string, string> | null = null;

async function readSettings(): Promise<Record<string, string>> {
  if (settingsCache) return settingsCache;
  try {
    settingsCache = await fetchSettings();
  } catch {
    settingsCache = {}; // 読めなくても既定で動く。ここで送信を止める理由はない。
  }
  return settingsCache;
}

/**
 * 用途 → モデル。利用者の設定があればそれを使う。
 *
 * <p>🔴 **`ai.gemini.model` は設定画面にあるのに、これまで誰も読んでいなかった**
 * （プラグインが自前の定数を使っていた）。用途で頼む形にしたついでに、設定が効くようにする。
 */
async function resolveModel(capability: AiCapability): Promise<{ model: string; apiVersion?: string }> {
  const values = await readSettings();
  const configured = values[MODEL_SETTING_KEYS[capability]];
  return {
    model: configured && configured.trim() ? configured.trim() : DEFAULT_MODELS[capability],
    apiVersion: values[API_VERSION_SETTING_KEY] || undefined,
  };
}

/** テスト用。設定の読み直しを強制する。 */
export function resetAiSettingsCache(): void {
  settingsCache = null;
}

export interface AiGenerationOptions {
  /** 呼び出し元プラグインのマニフェスト（権限確認と表示に使う）。 */
  manifest: PluginManifest;
  /**
   * 用途。**これを渡すのが新しい書き方**——モデルも宛先も本体が決める
   * （設計: `fw/ai-routing-design.md`）。
   */
  capability?: AiCapability;
  /** @deprecated `capability` を使う。渡された場合はそのまま尊重する（既存プラグイン互換）。 */
  model?: string;
  apiVersion?: string;
  prompt: string;
  /** 送信する画像そのもの（PNG 等のエンコード済みバイト列）。 */
  imageBytes: Uint8Array;
  mimeType?: string;
  /**
   * 同意を覚えておく単位。通常はシリーズ UID を渡す。
   * **セッション内・同一スコープに限る**（リロードで消える、別シリーズでは出し直す）。
   */
  scopeKey?: string;
  temperature?: number;
  /** @deprecated `capability` から決まる。 */
  responseModalities?: string[];
  /** 提供元固有の追い込み。**無くても動くこと。** */
  providerOptions?: Record<string, unknown>;
}

export type AiGenerationOutcome =
  | AiGenerateResult
  | { ok: false; error: "desktop-only" | "permission-denied" | "no-api-key" | "canceled" };

// ── 同意待ちの 1 件（本体のツリーが購読する） ────────────────────────────────
interface Pending {
  request: AiEgressRequest;
  resolve: (v: { ok: true; remember: boolean } | { ok: false }) => void;
}
let pending: Pending | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}
/**
 * 同意待ちの 1 件を購読する。
 *
 * <p>この 3 つ（`subscribeAiConsent` / `peekAiConsent` / `settleAiConsent`）が同意ストアの
 * 公開 API。**同意ダイアログを描く側**（{@link AiEgressConsentHost}、および同じことをする
 * 別ウィンドウのルート）がこれを使う。外から見えるようにしてあるのは、
 * 描く場所が 1 つに限らないため（2D ビューアとメイン画面は別ルート）。
 */
export function subscribeAiConsent(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
/** いま同意を待っている 1 件（無ければ null）。 */
export function peekAiConsent(): Pending | null {
  return pending;
}

/** 同意を覚えた組（`pluginId::scopeKey`）。**セッション内のみ**。永続化しない。 */
const remembered = new Set<string>();

function askConsent(request: AiEgressRequest): Promise<{ ok: true; remember: boolean } | { ok: false }> {
  // 同時に 2 つ出すと、どちらに同意したのか分からなくなる。1 本に限る。
  if (pending) return Promise.resolve({ ok: false });
  return new Promise((resolve) => {
    pending = { request, resolve };
    emit();
  });
}

/** 同意の結果を確定する（同意ストアの公開 API・{@link subscribeAiConsent} 参照）。 */
export function settleAiConsent(result: { ok: true; remember: boolean } | { ok: false }): void {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(result);
}

/** 大きい配列で `String.fromCharCode(...bytes)` はスタックを溢れさせるので分割する。 */
function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

/**
 * 画像 1 枚＋プロンプトを外部 AI へ送る。**プラグインが外部送信に使える唯一の関数。**
 *
 * <p>例外は投げない。失敗は値で返す（鍵入りのメッセージが例外として流れるのを避けるため、
 * main プロセス側も同じ方針）。
 */
export async function requestAiGeneration(opts: AiGenerationOptions): Promise<AiGenerationOutcome> {
  const d = desktop();
  if (!d?.aiGenerate || !d.secretStatus) {
    // web モードにはプラグインも Electron も無い。届かないことをそのまま返す。
    return { ok: false, error: "desktop-only" };
  }

  // (1) 権限。宣言していないプラグインには、鍵も送信経路も渡さない。
  const perms = opts.manifest.permissions ?? [];
  if (!perms.includes(AI_EGRESS_PERMISSION)) {
    log.warn(`[ai] ${opts.manifest.id}: ${AI_EGRESS_PERMISSION} が未宣言のため送信を拒否`);
    return { ok: false, error: "permission-denied" };
  }

  // (2) 鍵。無いまま同意だけ取らせるのは無駄なので先に見る。
  const status = await d.secretStatus(SECRET_KEY);
  if (!status.hasValue) return { ok: false, error: "no-api-key" };

  // (3) 用途 → モデル。プラグインがモデルを名指ししてきた場合はそれを尊重する（互換）。
  const capability: AiCapability = opts.capability ?? "image-to-image";
  const resolved = opts.model
    ? { model: opts.model, apiVersion: opts.apiVersion }
    : await resolveModel(capability);

  const imageBase64 = bytesToBase64(opts.imageBytes);
  // 🔴 **同意の単位に宛先を含める。** 提供元が増えたとき、ある提供元への同意が
  //    別の提供元への送信を黙って許してはならない——同じ画像でも送り先が違えば別の外部送信。
  //    段 3 で解決後の providerId が入る。いまは提供元が 1 つなので AI_PROVIDER_ID。
  const scope = `${opts.manifest.id}::${AI_PROVIDER_ID}::${opts.scopeKey ?? ""}`;

  // (4) 同意。覚えているのは「同一プラグイン × 同一提供元 × 同一スコープ」だけ。
  if (!remembered.has(scope)) {
    const consent = await askConsent({
      pluginId: opts.manifest.id,
      pluginName: opts.manifest.name,
      host: AI_HOST,
      model: resolved.model,
      prompt: opts.prompt,
      imageDataUrl: `data:${opts.mimeType ?? "image/png"};base64,${imageBase64}`,
      imageBytes: opts.imageBytes.length,
    });
    if (!consent.ok) return { ok: false, error: "canceled" };
    if (consent.remember && opts.scopeKey) remembered.add(scope);
  }

  // (5) 監査。**画像そのものは残さない**（ログに患者画素を溜め込まない）。
  //     残すのは「いつ・どのプラグインが・どこへ・どれだけ・どんな指示で」出したか。
  log.info(
    `[ai] egress plugin=${opts.manifest.id} provider=${AI_PROVIDER_ID} host=${AI_HOST} ` +
      `capability=${capability} model=${resolved.model} ` +
      `bytes=${opts.imageBytes.length} promptChars=${opts.prompt.length}`,
  );

  return d.aiGenerate({
    capability,
    model: resolved.model,
    apiVersion: resolved.apiVersion,
    prompt: opts.prompt,
    imageBase64,
    mimeType: opts.mimeType ?? "image/png",
    responseModalities: opts.responseModalities,
    temperature: opts.temperature,
    providerOptions: opts.providerOptions,
  });
}

/** テスト・画面遷移用。セッション中に覚えた同意を捨てる。 */
export function forgetAiConsents(): void {
  remembered.clear();
}

/**
 * 同意ダイアログの置き場。**本体のツリーの中で描くこと**（i18n コンテキストを効かせるため）。
 * 2D ビューアとメイン画面は別ウィンドウ＝別ルートなので、両方に置く。
 */
export function AiEgressConsentHost(): ReactNode {
  const p = useSyncExternalStore(subscribeAiConsent, peekAiConsent, peekAiConsent);
  if (!p) return null;
  return (
    <AiEgressConsentDialog
      request={p.request}
      onConfirm={(remember) => settleAiConsent({ ok: true, remember })}
      onCancel={() => settleAiConsent({ ok: false })}
    />
  );
}

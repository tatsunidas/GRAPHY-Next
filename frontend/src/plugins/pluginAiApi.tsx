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
import { desktop } from "../desktopBridge";
import { log } from "../log";
import { AiEgressConsentDialog, type AiEgressRequest } from "./AiEgressConsentDialog";
import type { PluginManifest } from "./pluginTypes";
import type { AiCapability, AiProvenance, AiResolveResult } from "../desktopBridge";

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
/**
 * 旧版（0.3.0）の鍵名。提供元ごとの鍵（`ai.provider.<id>.apiKey`）へ移ったが、
 * 版を上げた利用者が入れ直さずに済むよう main 側が旧名も見る（`aiProviders.secretKeyCandidates`）。
 * ここでは設定画面の既定表示のためだけに公開している。
 */
export const AI_LEGACY_SECRET_KEY = "ai.gemini.apiKey";

/**
 * 用途 → どこへ何で送るか。**解決は Electron main が行う。**
 *
 * <p>🔑 レンダラ側で同じ計算を持たない。同意画面に出す宛先と実際の宛先がずれる余地を作らない
 * （設計: `fw/ai-routing-design.md` §4）。
 *
 * <p>⚠ 解決できない場合（その用途を扱える提供元が無い等）は**送信前に**返す。
 */
async function resolvePlan(
  d: NonNullable<ReturnType<typeof desktop>>,
  capability: AiCapability,
): Promise<AiResolveResult> {
  if (!d.aiResolve) {
    // 0.3.0 の main には居ない。従来どおり Gemini の既定へ落ちる（互換）。
    // 🔴 **鍵の有無は必ず見る。** ここで true を決め打ちにすると、古い main で
    //    「鍵が無いのに同意ダイアログが出る」——同意を取ってから失敗する形になる。
    const status = d.secretStatus ? await d.secretStatus(AI_LEGACY_SECRET_KEY) : { hasValue: false };
    return {
      ok: true,
      providerId: AI_PROVIDER_ID,
      label: "Google Gemini",
      kind: "gemini",
      model: capability === "image-to-text" ? "gemini-2.5-flash" : "gemini-3.1-flash-image",
      endpointHost: AI_HOST,
      hasApiKey: status.hasValue,
    };
  }
  return d.aiResolve(capability);
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

/**
 * 生成できたときの形。**プラグインに渡すのはこれ。**
 *
 * <p>🔴 **`image` は `Uint8Array`。** Electron main は base64 で返すが、**変換は本体が行う**
 * （設計 §3.2「正規化は本体で」）。
 *
 * <p>🚨 **2026-09-27 に実機で発覚した不具合の場所。** main の結果を素通しにしていたため、
 * 契約は `bytes` と言っているのに `base64` が届き、プラグインは
 * **「画像が返らなかった」と表示していた**（`plugin-art` の `errNoImage`）。
 * 単体テストは「送る前に止まる」経路しか通っておらず、
 * `.d.ts` の照合テストは**名前だけ**を見る作りなので、どちらも捕まえられなかった。
 * → 下の `toOutcome()` が唯一の変換点。ここを素通しに戻さないこと。
 */
export interface AiGenerationSuccess {
  ok: true;
  image?: { bytes: Uint8Array; mimeType: string };
  text?: string;
  blockReason?: string;
  provenance?: AiProvenance;
  /** @deprecated 提供元の生レスポンス。移行期間だけ残す。 */
  data?: unknown;
}

export type AiGenerationOutcome =
  | AiGenerationSuccess
  | { ok: false; error: string; status?: number; kind?: string };

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
/**
 * base64 → バイト列。**契約が `Uint8Array` なので、境界でここだけが変換する。**
 *
 * <p>壊れた base64 で例外を投げない（提供元の応答は信用しない）。
 */
function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

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
  if (!d?.aiGenerate) {
    // web モードにはプラグインも Electron も無い。届かないことをそのまま返す。
    return { ok: false, error: "desktop-only" };
  }

  // (1) 権限。宣言していないプラグインには、鍵も送信経路も渡さない。
  const perms = opts.manifest.permissions ?? [];
  if (!perms.includes(AI_EGRESS_PERMISSION)) {
    log.warn(`[ai] ${opts.manifest.id}: ${AI_EGRESS_PERMISSION} が未宣言のため送信を拒否`);
    return { ok: false, error: "permission-denied" };
  }

  // (2) 用途 → どこへ何で送るか。**宛先を確定してから**鍵と同意を見る
  //     （宛先が分からないまま同意を取らせない）。
  const capability: AiCapability = opts.capability ?? "image-to-image";
  const plan = await resolvePlan(d, capability);
  if (!plan.ok) {
    log.warn(`[ai] ${opts.manifest.id}: ${capability} を扱える提供元がありません (${plan.error})`);
    return { ok: false, error: plan.error };
  }
  // プラグインがモデルを名指ししてきた場合はそれを尊重する（互換）。宛先は変えない。
  const model = opts.model ?? plan.model;

  // (3) 鍵。無いまま同意だけ取らせるのは無駄なので先に見る。**提供元ごとに見る。**
  if (!plan.hasApiKey) return { ok: false, error: "no-api-key" };

  const imageBase64 = bytesToBase64(opts.imageBytes);
  // 🔴 **同意の単位に宛先を含める。** ある提供元への同意が別の提供元への送信を
  //    黙って許してはならない——同じ画像でも送り先が違えば別の外部送信。
  const scope = `${opts.manifest.id}::${plan.providerId}::${opts.scopeKey ?? ""}`;

  // (4) 同意。覚えているのは「同一プラグイン × 同一提供元 × 同一スコープ」だけ。
  if (!remembered.has(scope)) {
    const consent = await askConsent({
      pluginId: opts.manifest.id,
      pluginName: opts.manifest.name,
      // 🔴 定数ではなく**解決後の宛先**を出す。画面と実際が食い違ってはならない。
      host: plan.endpointHost,
      model,
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
    `[ai] egress plugin=${opts.manifest.id} provider=${plan.providerId} host=${plan.endpointHost} ` +
      `capability=${capability} model=${model} ` +
      `bytes=${opts.imageBytes.length} promptChars=${opts.prompt.length}`,
  );

  const result = await d.aiGenerate({
    capability,
    model,
    apiVersion: opts.apiVersion,
    prompt: opts.prompt,
    imageBase64,
    mimeType: opts.mimeType ?? "image/png",
    responseModalities: opts.responseModalities,
    temperature: opts.temperature,
    providerOptions: opts.providerOptions,
  });
  if (!result.ok) return result;

  // 🔴 **ここが唯一の変換点。** main の形（base64）を契約の形（bytes）へ畳む。
  let image: { bytes: Uint8Array; mimeType: string } | undefined;
  if (result.image) {
    const bytes = base64ToBytes(result.image.base64);
    if (!bytes) {
      log.warn(`[ai] ${opts.manifest.id}: 画像を復号できませんでした`);
      return { ok: false, error: "invalid-image" };
    }
    image = { bytes, mimeType: result.image.mimeType };
  }
  return {
    ok: true,
    ...(image ? { image } : {}),
    ...(result.text !== undefined ? { text: result.text } : {}),
    ...(result.blockReason ? { blockReason: result.blockReason } : {}),
    ...(result.provenance ? { provenance: result.provenance } : {}),
    ...(result.data !== undefined ? { data: result.data } : {}),
  };
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

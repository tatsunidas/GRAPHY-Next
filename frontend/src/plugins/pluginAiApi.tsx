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

/** 送信先。UI に出す値であり、実際の接続は Electron main が行う。 */
export const AI_HOST = "generativelanguage.googleapis.com";
/** この権限を `plugin.json` の `permissions` に宣言していないプラグインは送信できない。 */
export const AI_EGRESS_PERMISSION = "ai-egress";
const SECRET_KEY = "ai.gemini.apiKey";

export interface AiGenerationOptions {
  /** 呼び出し元プラグインのマニフェスト（権限確認と表示に使う）。 */
  manifest: PluginManifest;
  model: string;
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
  responseModalities?: string[];
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
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
function snapshot(): Pending | null {
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

function settle(result: { ok: true; remember: boolean } | { ok: false }): void {
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

  const imageBase64 = bytesToBase64(opts.imageBytes);
  const scope = `${opts.manifest.id}::${opts.scopeKey ?? ""}`;

  // (3) 同意。覚えているのは「同一プラグイン × 同一スコープ」だけ。
  if (!remembered.has(scope)) {
    const consent = await askConsent({
      pluginId: opts.manifest.id,
      pluginName: opts.manifest.name,
      host: AI_HOST,
      model: opts.model,
      prompt: opts.prompt,
      imageDataUrl: `data:${opts.mimeType ?? "image/png"};base64,${imageBase64}`,
      imageBytes: opts.imageBytes.length,
    });
    if (!consent.ok) return { ok: false, error: "canceled" };
    if (consent.remember && opts.scopeKey) remembered.add(scope);
  }

  // (4) 監査。**画像そのものは残さない**（ログに患者画素を溜め込まない）。
  //     残すのは「いつ・どのプラグインが・どこへ・どれだけ・どんな指示で」出したか。
  log.info(
    `[ai] egress plugin=${opts.manifest.id} host=${AI_HOST} model=${opts.model} ` +
      `bytes=${opts.imageBytes.length} promptChars=${opts.prompt.length}`,
  );

  return d.aiGenerate({
    model: opts.model,
    apiVersion: opts.apiVersion,
    prompt: opts.prompt,
    imageBase64,
    mimeType: opts.mimeType ?? "image/png",
    responseModalities: opts.responseModalities,
    temperature: opts.temperature,
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
  const p = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!p) return null;
  return (
    <AiEgressConsentDialog
      request={p.request}
      onConfirm={(remember) => settle({ ok: true, remember })}
      onCancel={() => settle({ ok: false })}
    />
  );
}

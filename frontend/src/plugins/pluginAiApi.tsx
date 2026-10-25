/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグインから外部 AI へ画像を送るための入口（fw/art-of-imaging-design.md §3）。
 *
 * <h3>ここは境界ではない</h3>
 * プラグインは同じ renderer に `import()` されるので、`window.graphyDesktop.aiGenerate` を直接呼べる。
 * よって**同意・監査・送信先の確認は Electron main（`desktop/aiEgressGate.js`）が行う**。
 * ここは (1) `ai-egress` 権限の早期確認（善意のプラグインへの親切）(2) 自己申告の pluginId / scopeKey を添える
 * (3) main の base64 を契約の `Uint8Array` へ畳む、だけを担う。
 *
 * <h3>`ai-egress` の限界</h3>
 * main は呼び出し元のプラグインを区別できない。main が確かめるのは「申告された id がインストール済みで
 * `ai-egress` を宣言している」ことだけで、悪意あるプラグインが別のプラグインを名乗るのは防げない
 * （防ぐにはプラグインの隔離が要る）。
 */
import { desktop } from "../desktopBridge";
import { log } from "../log";
import type { PluginManifest } from "./pluginTypes";
import type { AiCapability, AiProvenance } from "../desktopBridge";

/** この権限を `plugin.json` の `permissions` に宣言していないプラグインは送信できない。 */
export const AI_EGRESS_PERMISSION = "ai-egress";

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

  // 宛先・モデルの解決、鍵の確認、送信前の同意、監査は main が行う（上の説明参照）。
  const capability: AiCapability = opts.capability ?? "image-to-image";
  const imageBase64 = bytesToBase64(opts.imageBytes);

  const result = await d.aiGenerate({
    capability,
    model: opts.model ?? "",
    claimedPluginId: opts.manifest.id,
    scopeKey: opts.scopeKey,
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

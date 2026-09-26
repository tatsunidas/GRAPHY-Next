/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Electron が preload で公開するデスクトップ専用 API への薄いアクセサ。
// web/ブラウザでは undefined（呼び出し側で機能を出し分ける）。

/** Electron screen.getAllDisplays() の一部を平坦化したもの（モニター診断用）。 */
export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
  internal: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  size: { width: number; height: number };
  scaleFactor: number;
  rotation: number;
  colorDepth: number;
  colorSpace: string;
  depthPerComponent: number;
  displayFrequency: number;
  monochrome: boolean;
}

/**
 * OS の物理メモリ量（ボリューム構築のバジェット決定用。`fw/volume-memory-guard.md` V3）。
 *
 * <p>ブラウザからは実搭載量を取る API が無い（`navigator.deviceMemory` は Chromium 限定・
 * 2 の冪に丸め・8GB で打ち止め）ため、standalone では Electron main から受け取る。
 */
export interface MemoryInfo {
  totalBytes: number;
  freeBytes: number;
}

/** 秘密情報の状態。**値そのものは決して返らない**（main プロセスから出さない設計）。 */
export interface SecretStatus {
  /** 設定済みか。 */
  hasValue: boolean;
  /** ディスクへ永続化できているか。false なら「この起動中だけ」保持されている。 */
  persisted: boolean;
  /** OS のキーチェーン（DPAPI / Keychain / libsecret 等）が使えるか。 */
  encryptionAvailable: boolean;
}

/** 秘密情報の保存結果。`persisted=false` は UI で必ず伝えること（黙って消えるため）。 */
export interface SecretSetResult extends SecretStatus {
  ok: boolean;
  /** `no-os-keyring` / `encrypt-failed` / `write-failed` / `empty` / `too-long` / `unknown-key` */
  reason?: string;
}

/** Gemini 中継の要求。解釈は一切せず、生 JSON がそのまま返る。 */
/** 用途。**提供元ではなくこれで頼む**（設計: fw/ai-routing-design.md §2）。 */
export type AiCapability = "image-to-image" | "image-to-text";

export interface AiGenerateRequest {
  /** 用途。main 側が応答の種類を決める。 */
  capability?: AiCapability;
  model: string;
  prompt: string;
  /** 送信画像（base64、データ URL の接頭辞は含めない）。 */
  imageBase64: string;
  mimeType?: string;
  /** @deprecated capability から決まる。既存プラグイン互換のため残す。 */
  responseModalities?: string[];
  temperature?: number;
  /** 既定 "v1beta"。新モデルの機能が先に載るのは常に v1beta 側。 */
  apiVersion?: string;
  /** 提供元固有の追い込み。**無くても動くこと。** */
  providerOptions?: Record<string, unknown>;
}

/** 用途の解決結果。 */
export type AiResolveResult =
  | {
      ok: true;
      providerId: string;
      label: string;
      kind: string;
      model: string;
      endpointHost: string;
      hasApiKey: boolean;
    }
  | { ok: false; error: string };

/** 提供元 1 件。**鍵は含まない**（`hasApiKey` で有無だけ）。 */
export interface AiProviderEntry {
  id: string;
  label: string;
  kind: string;
  endpoint: string;
  /** 用途 → モデル ID。**無い用途はその提供元では使えない。** */
  models: Record<string, string>;
  hasApiKey?: boolean;
  /** 鍵を保存するときのキー名（`secretSet` に渡す）。 */
  secretKey?: string;
}

export interface AiProvidersConfig {
  providers: AiProviderEntry[];
  /** 用途 → 提供元 id。 */
  defaults: Record<string, string>;
  /** 読み込み時に捨てた設定の理由。**黙って捨てない。** */
  problems: string[];
  capabilities: string[];
}

/** どこで何によって作られたか。作品の再現性と監査のために持ち回る。 */
export interface AiProvenance {
  providerId: string;
  kind: string;
  model: string;
  endpointHost: string;
}

/**
 * 中継の結果。**例外ではなく値で失敗を返す**（鍵入りのスタックを境界へ流さないため）。
 *
 * <p>🔑 `image` / `text` は**提供元非依存**。提供元ごとの応答の形は main のアダプタが畳む。
 */
export type AiGenerateResult =
  | {
      ok: true;
      image?: { base64: string; mimeType: string };
      text?: string;
      /** 何も返らなかった理由（安全フィルタ等）。`image` も `text` も無いときだけ入る。 */
      blockReason?: string;
      provenance?: AiProvenance;
      /** @deprecated 提供元の生レスポンス。移行期間だけ残す。 */
      data?: unknown;
    }
  | { ok: false; error: string; status?: number; kind?: string };

/** 名前を付けて保存の結果。`canceled` はユーザーが取り消しただけで、失敗ではない。 */
export type SaveFileResult =
  | { ok: true; filePath: string }
  | { ok: false; canceled?: boolean; error?: string };

export interface GraphyDesktop {
  pickImportPaths: () => Promise<string[]>;
  /** 単一の出力先フォルダを選ぶ（SeriesExtractor のコピー先など）。キャンセル時 null。 */
  pickDirectory?: () => Promise<string | null>;
  /** 2d/3d/mpr/slicer 等の独立ビューアを新規ウィンドウで開く。 */
  openViewer?: (screen: string) => Promise<void>;
  /** 接続中の全ディスプレイ情報を取得（モニター診断、デスクトップのみ）。 */
  listDisplays?: () => Promise<DisplayInfo[]>;
  /** 指定モニターに目視テストパターンをフルスクリーン表示する（デスクトップのみ）。 */
  openMonitorQc?: (displayId: number) => Promise<void>;
  /** PNG dataURL を OS のネイティブドラッグで外部（デスクトップ/他アプリ）へ書き出す。 */
  startDrag?: (dataUrl: string, filename: string) => void;
  /** OS 標準のメモリ/システムモニタ（Windows=タスクマネージャ, macOS=アクティビティモニタ, Linux=システムモニタ）を起動する。 */
  openMemoryMonitor?: () => Promise<void>;
  /** OS の物理メモリ量を取得（ボリューム構築のバジェット決定用、デスクトップのみ）。 */
  getMemoryInfo?: () => Promise<MemoryInfo>;
  /** 外部 URL / mailto を OS の既定アプリ（ブラウザ・メーラ）で開く。 */
  openExternal?: (url: string) => void;
  /** GitHub Releases の最新リリース情報を取得（更新確認、デスクトップのみ）。失敗時 null。 */
  checkForUpdate?: () => Promise<{
    tagName: string;
    name: string;
    body: string;
    htmlUrl: string;
    publishedAt: string | null;
  } | null>;
  /** アプリ全体を再起動する（DICOM 自局設定などの反映用、デスクトップのみ）。 */
  relaunch?: () => Promise<void>;
  /** ネイティブダイアログ（confirm/alert/prompt）後にレンダラのキーボードフォーカスを復帰させる。 */
  refocus?: () => void;
  /** 秘密情報を OS のキーチェーンで暗号化して保存する（デスクトップのみ）。 */
  secretSet?: (key: string, value: string) => Promise<SecretSetResult>;
  /** 秘密情報の「有無」だけを問い合わせる。**値は返らない。** */
  secretStatus?: (key: string) => Promise<SecretStatus>;
  /** 保存済みの秘密情報を消す。 */
  secretClear?: (key: string) => Promise<boolean>;
  /**
   * 外部 AI API への中継（デスクトップのみ）。
   *
   * <p>⚠ **直接呼ばないこと。** 患者画像の外部送信には同意と監査が要る。
   * 呼び出しは必ず `plugins/pluginAiApi.ts` の `requestAiGeneration()` を通す。
   */
  aiGenerate?: (req: AiGenerateRequest) => Promise<AiGenerateResult>;
  /**
   * 用途 → どこへ何で送るか。**同意ダイアログに出す宛先を知るため**に呼ぶ。
   *
   * <p>🔑 解決の権限は Electron main に 1 つだけ（レンダラ側に同じ計算を持つと、
   * 同意画面に出す宛先と実際の宛先がずれる余地ができる）。
   */
  aiResolve?: (capability: AiCapability) => Promise<AiResolveResult>;
  /** 提供元の一覧と用途ごとの既定。**鍵の値は返らない**（有無だけ）。 */
  aiProvidersGet?: () => Promise<AiProvidersConfig>;
  aiProvidersSet?: (cfg: { providers: AiProviderEntry[]; defaults: Record<string, string> }) =>
    Promise<{ ok: boolean; problems: string[] }>;
  /** 名前を付けて保存（OS ダイアログ）。**上書き確認は OS が出す。** */
  saveFile?: (payload: {
    defaultName: string;
    bytes: Uint8Array;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<SaveFileResult>;
}

export function desktop(): GraphyDesktop | undefined {
  return (window as unknown as { graphyDesktop?: GraphyDesktop }).graphyDesktop;
}

export const isDesktop = (): boolean => !!desktop();

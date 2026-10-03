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
      /**
       * 平文 http で送る宛先か（院内に自分で立てたサーバだけ起こりうる）。
       *
       * 🔴 **同意ダイアログで必ず言う。** 患者画素が院内 LAN を暗号化されずに流れる。
       */
      plaintext?: boolean;
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
  /** 平文 http の宛先（院内アドレスのみ許される）。画面に印を出す。 */
  plaintext?: boolean;
  /** 認証の載せ方。未指定ならアダプタの既定。旧い形の文字列も来る。 */
  auth?: { header?: string; prefix?: string } | string;
  /** パスの組み方（`kind` の既定を上書きしたいときだけ）。 */
  pathStyle?: string;
  /** API バージョン（Azure は必須・Gemini は `v1beta` 等）。 */
  apiVersion?: string;
  /** 用途 → パスの上書き。差し込みは無く、完全置換。 */
  paths?: Record<string, string>;
  /** 追加ヘッダ。**UI には出さない**（鍵を貼られるため・設計 §14）。 */
  headers?: Record<string, string>;
}

/**
 * 疎通確認の結果。
 *
 * <p>🔑 `verdict` は**何を直せばよいか**の分類。状態コードをそのまま見せても
 * 利用者は次の行動を決められない。
 * <p>🔴 **ヘッダは名前だけ**（値は返ってこない）。認証ヘッダ名は設定で選べるので、
 * どのヘッダに鍵が載るかは固定できない。
 */
export type AiTestResult = {
  ok: boolean;
  verdict:
    | "reachable" | "blocked" | "unreadable-response"
    | "auth-failed" | "not-found" | "bad-request" | "rate-limited" | "server-error" | "http-error"
    | "network" | "timeout" | "tls"
    | "no-api-key" | "config" | "busy" | "too-soon" | "canceled";
  status?: number;
  elapsedMs?: number;
  /** 送った先（`POST https://host/path`）。**組み立てた結果そのもの。** */
  requestLine?: string;
  /** 送ったヘッダの名前だけ。 */
  headerNames?: string[];
  /** 返ってきた本文の先頭（マスク済み・1000 文字まで）。 */
  bodyPreview?: string;
  text?: string;
  imageBytes?: number;
  blockReason?: string;
  plaintext?: boolean;
  retryAfterMs?: number;
  error?: string;
};

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
  /** 平文 http で送った（院内ホストのみ）。作品の由来として残す。 */
  plaintext?: boolean;
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

/** 開くダイアログの結果（H43）。`canceled` はユーザーが取り消しただけで、失敗ではない。 */
export type PickFilesResult =
  | { ok: true; paths: string[] }
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
  /** 検査だけ（書かない）。入力中に叩く。 */
  aiProvidersValidate?: (cfg: { providers: AiProviderEntry[]; defaults?: Record<string, string> }) =>
    Promise<{ ok: boolean; problems: string[] }>;
  /**
   * 疎通確認。**渡せるのは提供元と用途だけ**——送る指示と画像は main が持つ定数。
   * これにより、この口を呼べても患者画像を外へ出すことはできない。
   */
  aiTestConnection?: (providerId: string, capability: AiCapability) => Promise<AiTestResult>;
  /**
   * 用途ごとの既定だけを差し替える。**確認ダイアログは出ない**
   * （提供元の一覧を送らないので、この口からは新しい送信先が生えない）。
   */
  aiDefaultsSet?: (defaults: Record<string, string>) => Promise<{ ok: boolean; problems: string[] }>;
  aiProvidersSet?: (cfg: { providers: AiProviderEntry[]; defaults: Record<string, string> }) =>
    // 🔑 `canceled` は「main の確認ダイアログで利用者が取り消した」。失敗ではないので
    //    エラーとして見せない（`problems` は空で返る）。
    Promise<{ ok: boolean; problems: string[]; canceled?: boolean }>;
  /** 外部の計算機（Jupyter Server）の一覧。**トークンの値は返らない**（有無だけ）。fw/remote-compute-design.md */
  computeEndpointsGet?: () => Promise<ComputeEndpointsConfig>;
  /** 検査だけ（書かない）。入力中に叩く。検査規則は main に 1 つだけ。 */
  computeEndpointsValidate?: (cfg: { endpoints: ComputeEndpointInput[] }) =>
    Promise<{ ok: boolean; problems: string[] }>;
  /**
   * 一覧を保存する。送信先が増える・変わるときは **main が確認ダイアログを出す**
   * （`canceled` は利用者が取り消した。失敗ではない）。
   */
  computeEndpointsSet?: (cfg: { endpoints: ComputeEndpointInput[] }) =>
    Promise<{ ok: boolean; problems: string[]; canceled?: boolean }>;
  /** 接続テスト。**渡せるのは id だけ**——実行するコードは backend の定数。 */
  computeTestConnection?: (id: string) => Promise<ComputeTestResult>;
  /**
   * 外部の計算機へ送る前の同意。**渡せるのは要求の id だけ**——見せる内容（宛先・データ・コード全文）は
   * main が backend から取り直し、main の窓で聞く（プラグインからは迂回できない）。
   */
  computeConfirm?: (requestId: string) => Promise<
    { ok: true; approved: boolean } | { ok: false; error: string }
  >;
  /** Colab: ログインの状態（トークンは返らない）。fw/remote-compute-design.md §15 */
  computeColabStatus?: () => Promise<ColabStatus>;
  /** Colab: Google でログイン（利用者のブラウザが開く）。 */
  computeColabSignIn?: () => Promise<{ ok: boolean; email?: string | null; error?: string }>;
  /** Colab: ログアウト（確保したランタイムを解放し、Google 側の許可も取り消す）。 */
  computeColabSignOut?: () => Promise<{ ok: boolean; error?: string }>;
  /** Colab: プランと、選べるランタイムの種類。 */
  computeColabSpecs?: () => Promise<ColabSpecsResult>;
  /** Colab: その接続先のランタイムを確保する（済んでいれば何もしない）。データは送らない。 */
  computeColabEnsure?: (id: string) => Promise<{ ok: boolean; error?: string; allocated?: boolean; expireTime?: string }>;
  /** Colab: ランタイムを解放する。 */
  computeColabRelease?: (id: string) => Promise<{ ok: boolean; released?: boolean; error?: string }>;
  /**
   * 既定の計算機を用意する（計算機が 1 つも無く、Google にログイン済みなら Colab の GPU T4 を足す。足すのは main）。
   * error: colab-not-configured / colab-signin-required / t4-not-available / config-unreadable
   */
  computeEnsureDefault?: () => Promise<{ ok: true; endpointId: string; added: boolean } | { ok: false; error: string }>;
  /** 名前を付けて保存（OS ダイアログ）。**上書き確認は OS が出す。** */
  saveFile?: (payload: {
    defaultName: string;
    bytes: Uint8Array;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<SaveFileResult>;
  /** 開くダイアログ（ファイルだけ）。選んだ絶対パスを返す。 */
  pickFiles?: (payload: {
    title?: string;
    multiple?: boolean;
    filters?: { name: string; extensions: string[] }[];
  }) => Promise<PickFilesResult>;
  /** H56: プラグインのフォルダ選択。選んだフォルダは main が覚え、その中にだけ書ける。 */
  pluginPickDirectory?: (payload: { title?: string }) => Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }>;
  /** H56: 選んだフォルダの直下へ書く（上書きしない名前にする）。 */
  pluginWriteIntoDirectory?: (payload: { dir: string; name: string; bytes: Uint8Array }) => Promise<SaveFileResult>;
  /** H56: backend のジョブの成果物を選んだフォルダへ直接落とす。 */
  pluginDownloadIntoDirectory?: (payload: { dir: string; name: string; url: string }) => Promise<SaveFileResult>;
}

/** 外部の計算機の入力（保存・検査に渡す形）。トークンは含めない（`secretSet` で別に預ける）。 */
export interface ComputeEndpointInput {
  id: string;
  label: string;
  /** `jupyter`（既定・URL とトークン）か `colab`（Google の Colab・ランタイムの種類だけ持つ）。 */
  kind?: "jupyter" | "colab";
  /** jupyter のとき。 */
  url?: string;
  /** colab のとき（Colab API の RuntimeSpec）。 */
  spec?: ColabRuntimeSpec;
}

/** Colab のランタイムの種類（例 VARIANT_GPU / T4 / SHAPE_STANDARD）。 */
export interface ColabRuntimeSpec {
  variant: string;
  accelerator: string;
  shape: string;
}

export interface ComputeEndpointEntry extends ComputeEndpointInput {
  kind: "jupyter" | "colab";
  /** 平文 http（院内アドレスだけ許される）。画面は印を出す。 */
  plaintext?: boolean;
  /** トークンを預けるキー名（`secretSet` に渡す・jupyter のとき）。 */
  secretKey?: string;
  /** jupyter はトークンが入っているか、colab は Google でログインしているか。 */
  hasToken: boolean;
  /** colab のとき: 確保したランタイム（トークンは返らない）。 */
  runtime?: { allocated: boolean; name?: string; spec?: ColabRuntimeSpec; expireTime?: string };
}

export interface ColabStatus {
  /** OAuth クライアントの設定があるか（無ければログインできない）。 */
  configured: boolean;
  signedIn: boolean;
  email: string | null;
}

export type ColabSpecsResult =
  | { ok: true; tier: string | null; specs: (ColabRuntimeSpec & { eligible: boolean })[] }
  | { ok: false; error: string };

export interface ComputeEndpointsConfig {
  endpoints: ComputeEndpointEntry[];
  problems: string[];
  /** main と backend の内部経路が使えるか（backend を別に起動した開発では false）。 */
  available: boolean;
}

/** 接続テストの結果（backend の ComputeConnectionTester.Result）。 */
export interface ComputeTestResult {
  ok: boolean;
  /** 落ちた段: connect / kernelspecs / kernel / probe / bridge。成功なら done */
  stage: string;
  error?: string | null;
  httpStatus?: number;
  serverVersion?: string | null;
  kernels?: string[];
  probe?: {
    python?: string;
    platform?: string;
    gpus?: { name: string; memory?: string | null; driver?: string | null }[];
    torch?: { version: string; cuda: boolean; devices: string[] } | null;
  } | null;
  elapsedMs?: number;
}

export function desktop(): GraphyDesktop | undefined {
  return (window as unknown as { graphyDesktop?: GraphyDesktop }).graphyDesktop;
}

export const isDesktop = (): boolean => !!desktop();

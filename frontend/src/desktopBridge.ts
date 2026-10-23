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

/**
 * Chromium が報告した GPU の状態（描画環境の自己診断用。`fw/render-environment-design.md`）。
 * `featureStatus` は `app.getGPUFeatureStatus()`（例 `{ webgl2: "enabled" }`）。
 */
export interface GpuStatus {
  featureStatus: Record<string, string>;
  devices: { vendorId: number; deviceId: number; active: boolean }[];
}

/** 描画に使う GPU の選択。auto＝OS の既定、high＝高性能 GPU。 */
export type RenderGpuChoice = "auto" | "high";

/** GPU 1 つ分の搭載メモリ。 */
export interface GpuMemoryEntry {
  name: string;
  totalBytes: number;
}

export type RenderGpuFallback = "missing" | "unconfirmed" | "failed";

export interface RenderPrefsState {
  platform: string;
  prefs: { gpu: RenderGpuChoice };
  /** 設定の節を出せるか（GPU が 2 つ以上。Linux は NVIDIA ドライバが GPU を持つか、表示を担っていない AMD の GPU があること）。 */
  supported: boolean;
  /** 選択は高性能 GPU なのに付けなかった理由（見つからない／前回の起動が確定しなかった／前回 GPU が使えなかった）。付けたなら null。 */
  fallback: RenderGpuFallback | null;
  /** fallback が failed のときの原因（GPU プロセスの終了理由）。 */
  fallbackReason: string | null;
  /** 実機で効くことを確かめていない経路か（Windows・macOS・Linux の AMD）。画面に「検証中」と出す。 */
  unverified: boolean;
  /** この起動で、高性能 GPU の指定を実際に付けたか。保存した値との食い違い＝再起動待ち。 */
  appliedHigh: boolean;
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
export type AiCapability = "image-to-image" | "image-to-text" | "text-to-text" | "speech-to-text";

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
      /** 会話でツールを送るか（`none` ならテキスト中の JSON で代替する）。 */
      toolMode?: "native" | "none";
      /** この PC・院内の宛先か（自動フォールバックの対象になり得る）。 */
      local?: boolean;
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
  /** 会話でのツール呼び出し。`none` ならツールを送らない（関数呼び出しを持たないローカルモデル向け）。 */
  toolMode?: string;
  /** 鍵が要らない提供元（ループバックのローカルモデル）。鍵の欄・未設定の警告を出さない。 */
  keyless?: boolean;
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
export type AiListModelsResult =
  | { ok: true; models: string[]; truncated?: boolean }
  | { ok: false; verdict: string; error: string; status?: number };

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
  /** 用途 → 自動フォールバック先（ローカルだけ）。画面からはまだ編集しない。 */
  fallbacks?: Record<string, string[]>;
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
  /** 自動フォールバックで落ちた先のときだけ入る。元の（落ちた）提供元の id。 */
  fallbackFrom?: string;
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

/** 会話 1 件。画像は `user` だけが持てる。ツール結果は `tool`（`toolCallId` と `toolName` を付ける）。 */
export interface AiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  text?: string;
  images?: { base64: string; mimeType?: string }[];
  toolCalls?: AiToolCall[];
  toolCallId?: string;
  toolName?: string;
}

/** モデルが求めたツール呼び出し。`argsError` があれば引数が壊れている＝実行してはいけない。 */
export interface AiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  argsError?: string;
  /** 提供元の不透明な値。**そのまま次のターンへ返すこと**（Gemini の思考署名など）。 */
  providerState?: Record<string, unknown>;
}

export interface AiChatRequest {
  /** 同時に走らせるのは 1 セッション 1 本。`^[A-Za-z0-9_-]{1,64}$`。 */
  sessionId: string;
  messages: AiChatMessage[];
  tools?: { name: string; description?: string; parameters?: Record<string, unknown> }[];
  temperature?: number;
  /** true なら差分を `onAiChatEvent` へ流す。結果は最後にまとめて返る。 */
  stream?: boolean;
}

/**
 * 会話 1 ターンの結果。**1 呼び出し＝1 ターン**（ツール結果を返して次を呼ぶループは呼び出し側）。
 *
 * <p>`degraded` は自動フォールバックでローカルへ落ちたとき。**画面に必ず出す**（精度が落ちている）。
 * `droppedImages` は送れずに落とした画像の数（黙って欠損させない）。
 */
export interface AiTranscribeRequest {
  audio: { base64: string; mimeType: string };
  language?: string;
}
export type AiTranscribeResult =
  | {
      ok: true;
      text: string;
      /** ローカルへ縮退したとき。 */
      degraded?: boolean;
      provenance: { providerId: string; model: string; endpointHost: string; local: boolean; plaintext?: boolean; fallbackFrom?: string };
    }
  | { ok: false; error: string; status?: number; kind?: string };

export type AiChatResult =
  | {
      ok: true;
      text?: string;
      toolCalls?: AiToolCall[];
      finishReason?: string;
      blockReason?: string;
      droppedImages?: number;
      degraded?: boolean;
      provenance: AiProvenance;
    }
  | { ok: false; error: string; status?: number; kind?: string };

/** ストリームの差分。 */
export interface AiChatEvent {
  sessionId: string;
  type: "delta";
  text: string;
}

/** 名前を付けて保存の結果。`canceled` はユーザーが取り消しただけで、失敗ではない。 */
export type SaveFileResult =
  | { ok: true; filePath: string }
  | { ok: false; canceled?: boolean; error?: string };

/** 開くダイアログの結果（H43）。`canceled` はユーザーが取り消しただけで、失敗ではない。 */
export type PickFilesResult =
  | { ok: true; paths: string[] }
  | { ok: false; canceled?: boolean; error?: string };

/** DB フォルダ（索引と DICOM 保管庫をまとめたフォルダ）。 */
export interface DbFolderRow {
  path: string;
  isDefault: boolean;
  exists: boolean;
  active: boolean;
  /** この DB に Drive バックアップが設定されている。 */
  gdrive?: boolean;
}

/** Drive バックアップ: main が返す状態（トークン・API キーは返らない）。 */
/** ローカル AI の状態（main の localLlm.status() + defaultModelId）。 */
export interface AiLocalStatus {
  supported: boolean;
  platform?: string;
  defaultModelId?: string;
  models?: { id: string; label: string; size: number; license: string; licenseUrl?: string; note?: string }[];
  runtime?: { installed: boolean; build: string | null; size: number | null };
  model?: { installed: boolean; id: string | null; verified: boolean; file: string | null };
  running?: boolean;
  busy?: boolean;
  registered?: boolean;
  isDefault?: boolean;
  isFallback?: boolean;
  /** 音声入力（文字起こし）。任意で導入する。 */
  stt?: {
    models: { id: string; label: string; size: number; license: string; licenseUrl?: string; note?: string }[];
    defaultModelId: string | null;
    installed: boolean;
    id: string | null;
    running: boolean;
    registered: boolean;
    isDefault: boolean;
  };
}
export type AiLocalResult = { ok: true; [k: string]: unknown } | { ok: false; error: string };
export type AiLocalEvent =
  | { type: "progress"; phase: "runtime-download" | "runtime-extract" | "model-download" | "done"; received?: number; total?: number }
  | { type: "starting" }
  | { type: "state" };

export interface GdriveDesktopStatus {
  /** OAuth クライアントがこのアプリに入っているか。 */
  configured: boolean;
  /** Picker に使う API キーがあるか。 */
  pickerReady: boolean;
  signedIn: boolean;
  email: string | null;
  /** 使用中の DB に設定された保存先。無ければ null。 */
  folder: {
    name: string;
    shared: boolean;
    email: string | null;
    /** "backup"＝ローカルが正本（Drive にバックアップ）／"cache"＝Drive が正本（手元は上限つきキャッシュ）。 */
    mode: GdriveMode;
    /** モード A の手元の上限（バイト）。 */
    cacheLimitBytes: number;
  } | null;
  /** 上限の既定（15 GB）と、画面から選べる下限（1 GB）。バイト。 */
  defaultCacheLimitBytes: number;
  minCacheLimitBytes: number;
}

export type GdriveMode = "backup" | "cache";

export type GdriveActionResult = { ok: true; name?: string; parentName?: string; shared?: boolean; email?: string | null }
  | { ok: false; error?: string; canceled?: boolean };

export interface DbFolderList {
  /** この起動で使っている DB。 */
  active: string | null;
  /** 次の起動で使う DB。 */
  next: string;
  folders: DbFolderRow[];
}

export type DbFolderPickResult =
  | { ok: true; folder?: string; kind?: "db" | "empty"; network?: boolean }
  | { ok: false; canceled?: boolean; reason?: string };

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
  /** PNG dataURL をクリップボードへ書く（成否）。 */
  copyImage?: (dataUrl: string) => Promise<boolean>;
  /** OS 標準のメモリ/システムモニタ（Windows=タスクマネージャ, macOS=アクティビティモニタ, Linux=システムモニタ）を起動する。 */
  openMemoryMonitor?: () => Promise<void>;
  /** OS の物理メモリ量を取得（ボリューム構築のバジェット決定用、デスクトップのみ）。 */
  getMemoryInfo?: () => Promise<MemoryInfo>;
  /** Chromium の GPU 機能状態と GPU 一覧（描画環境の自己診断用、デスクトップのみ）。 */
  getGpuStatus?: () => Promise<GpuStatus>;
  /** GPU の搭載メモリ（設定＞描画環境、デスクトップのみ）。取れなければ null（Linux の NVIDIA 以外は未対応）。 */
  getGpuMemory?: () => Promise<GpuMemoryEntry[] | null>;
  /** 描画に使う GPU の選択（設定＞描画環境。ハイブリッド GPU の機械だけ。反映は再起動）。デスクトップのみ。 */
  getRenderPrefs?: () => Promise<RenderPrefsState>;
  setRenderPrefs?: (prefs: { gpu: RenderGpuChoice }) => Promise<{ ok: boolean; reason?: string }>;
  /** 前回 GPU が使えなかった（未確定だった）記録を消して、もう一度 GPU で試す（反映は再起動）。 */
  retryRenderPrefs?: () => Promise<{ ok: boolean }>;
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
  /** DIMSE TLS のパスワードを OS のキーチェーンに預ける（空文字は消す）。キーチェーンが無い環境は設定に平文で保存する。 */
  tlsPasswordSet?: (which: "keyStore" | "trustStore", value: string) => Promise<{ ok: boolean; persisted?: "keychain" | "plaintext"; reason?: string }>;
  /** TLS のパスワードが設定済みか・キーチェーンが使えるか（値は返らない）。 */
  tlsPasswordStatus?: () => Promise<{ encryptionAvailable: boolean; keyStore: boolean; trustStore: boolean }>;
  /**
   * プラグイン導入の同意を変える。有効にするときは main が確認ダイアログを出す。
   * 汎用の設定の API ではこのキーを書けない（main だけが通れる口で保存する）。
   */
  pluginInstallOptIn?: (enabled: boolean) => Promise<{ ok: boolean; canceled?: boolean; reason?: string; installEnabled?: boolean }>;
  /** DB フォルダの一覧（既定・最近使ったもの）と、今使っている DB。 */
  dbFoldersList?: () => Promise<DbFolderList>;
  /** 空のフォルダを選んで新しい DB フォルダにする（切り替えはしない）。 */
  dbFoldersCreate?: (title: string) => Promise<DbFolderPickResult>;
  /** 既存の DB フォルダ（または空のフォルダ）を選んで検査する（切り替えはしない）。 */
  dbFoldersPick?: (title: string) => Promise<DbFolderPickResult>;
  /** main が確認ダイアログを出し、了承されたら記録してアプリを再起動する。 */
  dbFoldersSwitch?: (folder: string) => Promise<DbFolderPickResult>;
  /** 最近使った一覧から外す（フォルダの中身には触れない）。 */
  dbFoldersForget?: (folder: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Drive バックアップ: 状態 / ログイン / ログアウト / 保存先を選んで有効化 / 解除（確認は main）。 */
  gdriveStatus?: () => Promise<GdriveDesktopStatus>;
  gdriveSignIn?: () => Promise<{ ok: boolean; email?: string | null; error?: string }>;
  gdriveSignOut?: () => Promise<{ ok: boolean; error?: string }>;
  /** mode を省くと "backup"（従来どおり）。 */
  gdriveEnable?: (mode?: GdriveMode) => Promise<GdriveActionResult>;
  /** モードの切替。条件（同期済み／全件が手元）を満たさなければ { ok:false, error } を返す（main が検査）。 */
  gdriveSetMode?: (mode: GdriveMode) => Promise<{ ok: boolean; error?: string }>;
  /** モード A の手元の上限（バイト）。下限未満は { ok:false, error:"invalid-limit" }。 */
  gdriveSetCacheLimit?: (bytes: number) => Promise<{ ok: boolean; error?: string }>;
  gdriveDisable?: () => Promise<{ ok: boolean; canceled?: boolean; error?: string }>;
  /** Drive のバックアップを選び、空のフォルダへ取り戻し始める。進み具合は backend の /api/gdrive/restore。 */
  gdriveRestore?: (
    title: string,
    mode?: GdriveMode,
  ) => Promise<{ ok: true; folder: string; mode?: GdriveMode } | { ok: false; error?: string; canceled?: boolean }>;
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
  /**
   * 会話（text-to-text・ツール・ストリーミング）。**アシスタント窓（`#assistant`）以外から呼ぶと
   * main が `forbidden` を返す**——プラグインが同じ realm からこの口を使えないようにするため。
   */
  aiChat?: (req: AiChatRequest) => Promise<AiChatResult>;
  aiChatCancel?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * 音声の文字起こし(アシスタント窓だけ。それ以外は `forbidden`)。送信先は main が決める
   * (`aiResolve("speech-to-text")` で事前に見られる)。録音は保存されない。
   */
  aiTranscribe?: (req: AiTranscribeRequest) => Promise<AiTranscribeResult>;
  /** マイクの利用可否(macOS は OS の許可ダイアログを出す)。アシスタント窓だけ。 */
  assistantMicAccess?: () => Promise<{ ok: boolean; status?: string; error?: string }>;
  /**
   * 2D ビューアへの表示操作（アシスタント窓から。**それ以外は main が `forbidden`**）。
   * 操作の中身の検証は 2D 窓が行う。窓が無ければ `no-viewer`。
   */
  assistantViewerCmd?: (
    sessionId: string,
    cmd: { kind: "action" | "getState"; id?: string; params?: unknown },
  ) => Promise<import("./assistant/actions/registry").ActionResult>;
  /** マクロ（表示操作の並び）の保存。アシスタント窓だけ（それ以外は main が `forbidden`）。形と大きさだけ main が検証する。 */
  assistantJournalList?: () => Promise<{
    ok: boolean;
    entries?: { ts: string; id: string; params?: Record<string, unknown>; ok: boolean; error?: string }[];
    error?: string;
  }>;
  assistantMacrosList?: () => Promise<{ ok: boolean; macros?: import("./assistant/macros/macroModel").Macro[]; error?: string }>;
  assistantMacrosSave?: (macro: {
    name: string;
    steps: import("./assistant/macros/macroModel").MacroStep[];
  }) => Promise<{ ok: boolean; macro?: import("./assistant/macros/macroModel").Macro; error?: string }>;
  assistantMacrosDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  /** 2D 窓側: main が中継してきた命令を受ける。購読解除の関数を返す。 */
  onViewerCmd?: (
    cb: (cmd: { reqId: string; kind: "action" | "getState"; id?: string; params?: unknown; includeLabels?: boolean; approved?: boolean }) => void,
  ) => () => void;
  /** 2D 窓側: 命令の結果を返す（main は命令を送った窓からのものだけ受理する）。 */
  viewerCmdResult?: (reqId: string, result: import("./assistant/actions/registry").ActionResult) => void;
  /** ストリームの差分を受ける。購読解除の関数を返す。 */
  onAiChatEvent?: (cb: (ev: AiChatEvent) => void) => () => void;
  /** ローカル AI（この PC の軽量 LLM）の状態。ダウンロード・削除は main が確認ダイアログを出す。 */
  aiLocalStatus?: () => Promise<AiLocalStatus>;
  aiLocalInstall?: (modelId?: string) => Promise<AiLocalResult>;
  aiLocalCancel?: () => Promise<{ ok: boolean }>;
  /** main がファイル選択を出す。`allowUnverified` は公式一覧にない GGUF を、検証なしで受け付けるとき。 */
  aiLocalImport?: (allowUnverified?: boolean) => Promise<AiLocalResult>;
  /** 起動して /health を確かめる。 */
  aiLocalCheck?: (role?: "llm" | "stt") => Promise<{ ok: boolean; startedMs?: number; error?: string }>;
  /** 音声入力のモデルだけを外す(確認ダイアログは main が出す)。 */
  aiLocalRemoveStt?: () => Promise<AiLocalResult>;
  aiLocalRole?: (role: { fallback?: boolean; makeDefault?: boolean }) => Promise<AiLocalResult>;
  aiLocalRemove?: () => Promise<AiLocalResult>;
  onAiLocalEvent?: (cb: (ev: AiLocalEvent) => void) => () => void;
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
   * モデル名の一覧を取る（GET のみ）。保存済みの提供元は `providerId`、追加フォームは
   * `{kind, endpoint, apiKey}`（組み込みの公式ホストだけ通る。それ以外は `verdict:"manual"`）。
   */
  aiListModels?: (args: { providerId?: string; kind?: string; endpoint?: string; apiKey?: string }) => Promise<AiListModelsResult>;
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
  /** 一括の計算の間、OS の眠りを止める。返すのは「いま実際に止めているか」（画面はこれを見て表示する）。 */
  computeKeepAwake?: (on: boolean) => Promise<{ ok: true; active: boolean }>;
  /** 眠りを止めているかの読み取りだけ（計算ジョブの窓の表示用。止めたり外したりしない）。 */
  computeKeepAwakeStatus?: () => Promise<{ ok: true; active: boolean }>;
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
  /**
   * この PC: 検出した Python で Jupyter Server を起動し、接続先 id `local` として使える状態にする。データは送らない。
   * error: local-unavailable（`reasons` に理由）/ server-exited / canceled / push-failed ほか
   */
  computeLocalEnsure?: () => Promise<{ ok: boolean; endpointId?: string; error?: string; reasons?: string[] }>;
  /** Colab: ランタイムを解放する。 */
  computeColabRelease?: (id: string) => Promise<{ ok: boolean; released?: boolean; error?: string }>;
  /**
   * 既定の計算機を用意する（計算機が 1 つも無く、Google にログイン済みなら Colab の GPU T4 を足す。足すのは main）。
   * error: colab-not-configured / colab-signin-required / t4-not-available / config-unreadable
   */
  /** この PC の Python と GPU の検出（見て出すだけ）。`force` が無ければ覚えている結果。 */
  computeLocalDetect?: (opts?: { force?: boolean }) => Promise<LocalDetectResult>;
  computeLocalCancel?: () => Promise<{ ok: boolean; running?: boolean }>;
  /** main のファイル選択と確認を通ったときだけ保存する。Python のパスを文字列で渡す口は無い。 */
  computeLocalPickPython?: () => Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }>;
  computeLocalUseAuto?: () => Promise<{ ok: true } | { ok: false; canceled?: boolean; error?: string }>;
  /** 既定の計算機を選ぶ（null＝自動）。登録に在る id か "local" だけ。新しい送り先は増えないので確認は出ない。 */
  computeDefaultSet?: (id: string | null) => Promise<{ ok: boolean; problems?: string[] }>;
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

/** この PC の Python の設定（`compute-endpoints.json` の最上位 `local`）。 */
export interface LocalPythonSetting {
  mode: "auto" | "path";
  path?: string;
}

export type LocalCandidateStatus = "selected" | "usable" | "missing" | "excluded" | "probe-failed";

export interface LocalCandidate {
  path: string;
  /** setting / py-launcher / path / conda-base */
  source: string;
  status: LocalCandidateStatus;
  /** 理由コード（excluded-windowsapps / excluded-no-clt / missing-jupyter-server など） */
  reasons: string[];
  /** probe-failed の詳細（exit:1 など） */
  detail?: string;
  versions: { python: string | null; jupyterServer: string | null; ipykernel: string | null; torch: string | null; cuda: string | null } | null;
  conda?: boolean;
  venv?: boolean;
  externallyManaged?: boolean;
  elapsedMs?: number;
}

export interface LocalGpuDevice {
  name: string | null;
  /** nvidia-smi の memory.total（MiB）。表示はこちら。 */
  memoryMiB: number | null;
  /** torch の total_memory（記録のみ）。 */
  memoryBytes: number | null;
  capability: number[] | null;
  /** そのビルドの get_arch_list() に含まれるか（判定できなければ null）。 */
  archSupported: boolean | null;
  /** PyTorch 側のデバイスと対応づいたか。 */
  torchDevice?: boolean;
}

export interface LocalCapabilities {
  accelerator: "cuda" | "mps" | "cpu" | null;
  devices: LocalGpuDevice[];
  torch: string | null;
  cudaRuntime: string | null;
  driver: string | null;
}

export interface LocalDetectResult {
  state: "ok" | "none" | "canceled" | "error";
  error?: string;
  python: LocalPythonSetting;
  selected: LocalCandidate | null;
  /** 選んだ Python が jupyter_server と ipykernel を持つか。 */
  usable: boolean;
  candidates: LocalCandidate[];
  searched: string[];
  nvidia: { found: boolean; path: string | null; gpus: { name: string; memoryMiB: number | null; driver: string | null; uuid: string | null }[]; error: string | null; unparsed: number };
  capabilities: LocalCapabilities | null;
  reasons: string[];
  guidance: { missing: string[]; commands: { shell: string; text: string }[]; links: string[] };
  elapsedMs: number;
}

export interface ComputeEndpointsConfig {
  endpoints: ComputeEndpointEntry[];
  problems: string[];
  local?: { python: LocalPythonSetting };
  /**
   * 既定の計算機（main が決めた結果。規則は desktop/computeDefault.js だけにあり、画面は読むだけ）。
   * "local"＝この PC／登録の id／null＝まだ決まらない。defaultMode: 利用者が選んだか自動か。
   * defaultError: 選んだ先が使えない（local-unavailable）。defaultPending: この PC の検出がまだで確定していない。
   */
  defaultId?: string | null;
  defaultMode?: "auto" | "chosen";
  defaultError?: string | null;
  defaultPending?: boolean;
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

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグインが「名前を付けて保存」するためのホスト API（fw/art-of-imaging-design.md §5）。
 *
 * <p>本体の既存の書き出しは全部 `graphy-capture-${Date.now()}.png` のような
 * タイムスタンプ名の自動ダウンロードで、**保存先を選ぶ手段も上書き確認も無かった**。
 * ここでは OS の保存ダイアログ（`dialog.showSaveDialog`）を使う。
 * **同名ファイルの上書き確認は OS が出す**ので、アプリ側で自前実装しない
 * ——自前の確認は OS の作法とずれるうえ、ネイティブダイアログの二重表示になる。
 *
 * <p>⚠ これは保管庫（DICOM アーカイブ）への書き込みではない。ユーザーが選んだ
 * 任意の場所へファイルを置くだけなので、派生シリーズ保存の同意ダイアログ
 * （`PluginSaveConfirmDialog`）の対象外である。代わりに、書き出す中身に患者情報が
 * 含まれ得ることはプラグイン側が利用者へ伝える責任を負う。
 */
import { apiBase } from "../apiBase";
import { desktop, type SaveFileResult } from "../desktopBridge";
import { log } from "../log";

export interface PluginSaveFileOptions {
  /** 保存ダイアログの初期ファイル名（拡張子込み）。 */
  defaultName: string;
  /** 書き出すバイト列。 */
  bytes: Uint8Array;
  /** 拡張子フィルタ。既定は PNG。 */
  filters?: { name: string; extensions: string[] }[];
}

/**
 * 名前を付けて保存する。
 *
 * @returns 保存できたらパス付き。ユーザーが取り消したら `canceled: true`（**失敗ではない**ので、
 *   呼び出し側はエラー表示をしないこと）。デスクトップ以外では `error: "desktop-only"`。
 */
export async function saveFileAs(opts: PluginSaveFileOptions): Promise<SaveFileResult> {
  const d = desktop();
  if (!d?.saveFile) return { ok: false, error: "desktop-only" };
  if (!opts.bytes || opts.bytes.length === 0) return { ok: false, error: "empty" };

  const result = await d.saveFile({
    defaultName: opts.defaultName,
    bytes: opts.bytes,
    filters: opts.filters ?? [{ name: "PNG", extensions: ["png"] }],
  });
  if (result.ok) {
    log.info(`[save] ${result.filePath} (${opts.bytes.length} bytes)`);
  } else if (!result.canceled) {
    log.error(`[save] 失敗: ${result.error ?? "unknown"}`);
  }
  return result;
}

/** H53 の保存の指定。 */
export interface PluginSaveArtifactOptions {
  /** 保存ダイアログの初期ファイル名（拡張子込み）。 */
  defaultName: string;
  /** 拡張子フィルタ。 */
  filters?: { name: string; extensions: string[] }[];
}

/**
 * H53: プラグインのジョブの成果物（JAR が一時フォルダに書いたファイル。結果の `__artifact`）を、
 * OS の保存ダイアログで利用者の選んだ場所へ保存する。
 *
 * <p>成果物は本体が預かり（`PluginArtifacts`・24 時間）、`GET /api/plugin-jobs/{jobId}/artifact` で取り寄せる。
 * 中身をいったん画面へ持ってくるので、極端に大きなファイル（数 GB）には向かない。
 */
export async function saveJobArtifact(jobId: string, opts: PluginSaveArtifactOptions): Promise<SaveFileResult> {
  const d = desktop();
  if (!d?.saveFile) return { ok: false, error: "desktop-only" };
  let bytes: Uint8Array;
  try {
    const res = await fetch(`${apiBase()}/api/plugin-jobs/${encodeURIComponent(jobId)}/artifact`);
    if (!res.ok) return { ok: false, error: `artifact-${res.status}` };
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return saveFileAs({ defaultName: opts.defaultName, bytes, filters: opts.filters ?? [{ name: "All files", extensions: ["*"] }] });
}

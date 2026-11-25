/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { desktop } from "../desktopBridge";
import type { OutputFile } from "./datasetCsv";
import { downloadText } from "./downloadText";

/** 保存先。Electron はフォルダを 1 回選んで全ファイルをそこへ書く。ブラウザは従来どおりダウンロード。 */
export type SaveTarget = { kind: "dir"; dir: string } | { kind: "browser" };

export type ChooseResult =
  | { ok: true; target: SaveTarget }
  | { ok: false; canceled?: boolean; error?: string };

export type SaveResult =
  | { ok: true; names: string[] }
  /** `names` は失敗する前に書けたファイル（実際の名前）。 */
  | { ok: false; names: string[]; error: string };

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** 保存先を決める。取り消したら `canceled`（何も書かない）。 */
export async function chooseSaveTarget(title?: string): Promise<ChooseResult> {
  const d = desktop();
  if (!d?.pluginPickDirectory || !d.pluginWriteIntoDirectory) return { ok: true, target: { kind: "browser" } };
  const r = await d.pluginPickDirectory({ title });
  return r.ok ? { ok: true, target: { kind: "dir", dir: r.path } } : r;
}

/**
 * 決めた保存先へファイルを書く。同名があるときの連番（「名前 (2).拡張子」）は main 側が付け、上書きしない。
 * 戻りの `names` は実際に書かれた名前。
 */
export async function saveFilesTo(target: SaveTarget, files: readonly OutputFile[]): Promise<SaveResult> {
  const names: string[] = [];
  if (target.kind === "browser") {
    for (const f of files) {
      downloadText(f.text, f.name, f.mime);
      names.push(f.name);
    }
    return { ok: true, names };
  }
  const write = desktop()?.pluginWriteIntoDirectory;
  if (!write) return { ok: false, names, error: "desktop-only" };
  const enc = new TextEncoder();
  for (const f of files) {
    const r = await write({ dir: target.dir, name: f.name, bytes: enc.encode(f.text) });
    if (!r.ok) return { ok: false, names, error: r.error ?? "write failed" };
    names.push(baseName(r.filePath));
  }
  return { ok: true, names };
}

/** フォルダを 1 回選んで全ファイルを保存する。取り消しは `{ ok: false, canceled: true }`。 */
export async function saveFiles(files: readonly OutputFile[], title?: string): Promise<SaveResult | { ok: false; canceled: true; names: [] }> {
  const c = await chooseSaveTarget(title);
  if (!c.ok) return c.canceled ? { ok: false, canceled: true, names: [] } : { ok: false, names: [], error: c.error ?? "pick failed" };
  return saveFilesTo(c.target, files);
}

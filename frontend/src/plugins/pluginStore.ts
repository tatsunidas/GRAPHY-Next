/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグイン保存領域（host API の H8）の host 側実装。
 *
 * <p><b>なぜ本体が持つのか</b>: プラグインが自前で持てる保存先は `localStorage`（端末ローカル）
 * しかない。時系列の評価（RECIST 等）は数か月〜数年にわたる記録なので、端末に閉じると
 * 別の PC で開いた読影医には過去の回が見えず、判定（nadir・BOR）が静かに変わる。
 *
 * <p><b>失敗を例外にしない</b>。プラグインに try/catch を強いると、握り潰されて
 * 「保存できていないのに保存したつもり」になりやすい。結果は必ず戻り値で返し、
 * とくに**衝突（409）は `conflict` として区別できる**ようにする
 * （プラグインは読み直して統合してから再保存する）。
 */
import {
  deletePluginDocument,
  fetchPluginDocument,
  savePluginDocument,
} from "./pluginStoreApi";

/** 読み出し結果。未保存でもエラーではなく `json: null` を返す。 */
export interface PluginStoreDoc {
  /**
   * **読み出せたか**。`false` は「読めなかった」であって「空」ではない。
   *
   * <p>両者を混ぜると、保存領域に到達できないとき（本体が古い・backend 停止）に
   * プラグインが「記録が無い」と判断して保存してしまい、**サーバ側の記録を空で上書きする**。
   * 実際、H8 を持たない backend に対して空扱いになり、保存できていないのに
   * 「共有されている」と表示された（2026-07-31 の実機検証）。
   */
  available: boolean;
  /** 保存されている JSON。未保存なら null。 */
  json: string | null;
  /** 楽観ロックの版。保存時にそのまま返送する。未保存なら null。 */
  version: number | null;
  /** 最終更新（ISO）。未保存なら null。 */
  updatedAt: string | null;
}

/** 保存結果。**衝突を握り潰さない**ための判別可能な形。 */
export type PluginStoreSaveResult =
  | { ok: true; version: number }
  /** 別ウィンドウ・別端末が先に保存していた。読み直して統合し、新しい版で再保存する。 */
  | { ok: false; conflict: true; message: string }
  | { ok: false; conflict: false; message: string };

const UNAVAILABLE: PluginStoreDoc = { available: false, json: null, version: null, updatedAt: null };

/** HTTP の失敗から状態番号を拾う（`http.ts` は status を持つ Error を投げる）。 */
function statusOf(e: unknown): number | null {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : null;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function loadPluginStore(pluginId: string, patientKey: string): Promise<PluginStoreDoc> {
  if (!patientKey) return UNAVAILABLE;
  try {
    const dto = await fetchPluginDocument(pluginId, patientKey);
    return { available: true, json: dto.json, version: dto.version, updatedAt: dto.updatedAt };
  } catch {
    // 読めない（backend 停止・古い backend でエンドポイントが無い等）。
    // **空として返さない**。空と読めない を混ぜると、プラグインが「記録が無い」と判断して
    // 保存し、サーバ側の記録を空で上書きする。
    return UNAVAILABLE;
  }
}

export async function savePluginStore(
  pluginId: string,
  patientKey: string,
  json: string,
  version: number | null,
): Promise<PluginStoreSaveResult> {
  if (!patientKey) {
    return { ok: false, conflict: false, message: "患者を特定できません" };
  }
  try {
    const dto = await savePluginDocument(pluginId, patientKey, json, version);
    return { ok: true, version: dto.version ?? 0 };
  } catch (e) {
    const status = statusOf(e);
    if (status === 409) {
      return { ok: false, conflict: true, message: messageOf(e) };
    }
    return { ok: false, conflict: false, message: messageOf(e) };
  }
}

export async function deletePluginStore(pluginId: string, patientKey: string): Promise<boolean> {
  if (!patientKey) return false;
  try {
    await deletePluginDocument(pluginId, patientKey);
    return true;
  } catch {
    return false;
  }
}

import { httpGet, httpSend } from "../http";

export type SettingsMap = Record<string, string>;

export const fetchSettings = () => httpGet<SettingsMap>("/api/settings");

/** 部分更新（送ったキーのみ上書き）。更新後の全設定を返す。 */
export const saveSettings = (updates: SettingsMap) =>
  httpSend<SettingsMap>("/api/settings", "PUT", updates);

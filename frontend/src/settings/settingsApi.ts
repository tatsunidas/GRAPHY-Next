import { apiBase } from "../api";

export type SettingsMap = Record<string, string>;

export async function fetchSettings(): Promise<SettingsMap> {
  const res = await fetch(`${apiBase()}/api/settings`);
  if (!res.ok) {
    throw new Error(`settings ${res.status}`);
  }
  return res.json();
}

/** 部分更新（送ったキーのみ上書き）。更新後の全設定を返す。 */
export async function saveSettings(updates: SettingsMap): Promise<SettingsMap> {
  const res = await fetch(`${apiBase()}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    throw new Error(`settings ${res.status}`);
  }
  return res.json();
}

export type SettingsMap = Record<string, string>;

const KEY = "graphy.portable.settings";

function read(): SettingsMap {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as SettingsMap;
  } catch {
    return {};
  }
}

export const fetchSettings = (): Promise<SettingsMap> => Promise.resolve(read());

export const saveSettings = (updates: SettingsMap): Promise<SettingsMap> => {
  const next = { ...read(), ...updates };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 保存できなくても動く */
  }
  return Promise.resolve(next);
};

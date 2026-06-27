// API のベース URL を解決する。
// - ブラウザ / Vite dev / Web 本番: 同一オリジン（相対パス）。空文字を返す。
// - Electron(file://): preload が window.__GRAPHY_API_BASE__ に backend の URL を注入する。
declare global {
  interface Window {
    __GRAPHY_API_BASE__?: string;
  }
}

export const apiBase = (): string => window.__GRAPHY_API_BASE__ ?? "";

export interface AppStatus {
  app: string;
  version: string;
  mode: string;
  activeProfiles: string[];
  javaVersion: string;
}

export async function fetchStatus(): Promise<AppStatus> {
  const res = await fetch(`${apiBase()}/api/status`);
  if (!res.ok) {
    throw new Error(`status ${res.status}`);
  }
  return res.json();
}

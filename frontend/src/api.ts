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

export interface Study {
  studyInstanceUid: string;
  patientId: string;
  patientName: string | null;
  studyDate: string | null;
  studyDescription: string | null;
  modality: string | null;
  numberOfInstances: number;
}

export interface Series {
  seriesInstanceUid: string;
  modality: string | null;
  seriesNumber: number | null;
  seriesDescription: string | null;
  numberOfInstances: number;
}

export interface Instance {
  sopInstanceUid: string;
  instanceNumber: number | null;
  sopClassUid: string | null;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`);
  if (!res.ok) {
    throw new Error(`${path} ${res.status}`);
  }
  return res.json();
}

export const fetchStudies = () => getJson<Study[]>("/api/studies");

export const fetchSeries = (studyUid: string) =>
  getJson<Series[]>(`/api/studies/${encodeURIComponent(studyUid)}/series`);

export const fetchInstances = (studyUid: string, seriesUid: string) =>
  getJson<Instance[]>(
    `/api/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(seriesUid)}/instances`,
  );

import { apiBase } from "../api";

export interface Patient {
  patientId: string;
  patientName: string | null;
  patientBirthDate: string | null;
  patientSex: string | null;
  numberOfStudies: number;
  numberOfInstances: number;
}

export interface PatientEdit {
  patientName: string;
  patientBirthDate: string;
  patientSex: string;
  newPatientId: string;
}

export interface StatBucket {
  key: string;
  value: number;
}

export interface Stats {
  studyCountByMonth: StatBucket[];
  studyCountByModality: StatBucket[];
  instanceCountByModality: StatBucket[];
  volumeBytesByModality: StatBucket[];
}

export const fetchPatients = (q?: string) =>
  get<Patient[]>(`/api/patients${q ? `?q=${encodeURIComponent(q)}` : ""}`);

export const fetchStats = () => get<Stats>("/api/stats");

export async function savePatient(patientId: string, edit: PatientEdit): Promise<void> {
  await send(`/api/patients/${encodeURIComponent(patientId)}`, "PUT", edit);
}

export async function deletePatient(patientId: string): Promise<void> {
  await send(`/api/patients/${encodeURIComponent(patientId)}`, "DELETE");
}

export async function deleteStudy(studyUid: string): Promise<void> {
  await send(`/api/studies/${encodeURIComponent(studyUid)}`, "DELETE");
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`);
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

async function send(path: string, method: string, body?: unknown): Promise<void> {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
}

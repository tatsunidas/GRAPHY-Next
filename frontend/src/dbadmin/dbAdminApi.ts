/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { httpGet, httpSend } from "../http";

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
  httpGet<Patient[]>(`/api/patients${q ? `?q=${encodeURIComponent(q)}` : ""}`);

export const fetchStats = () => httpGet<Stats>("/api/stats");

export const savePatient = (patientId: string, edit: PatientEdit) =>
  httpSend(`/api/patients/${encodeURIComponent(patientId)}`, "PUT", edit);

export const deletePatient = (patientId: string) =>
  httpSend(`/api/patients/${encodeURIComponent(patientId)}`, "DELETE");

export const deleteStudy = (studyUid: string) =>
  httpSend(`/api/studies/${encodeURIComponent(studyUid)}`, "DELETE");

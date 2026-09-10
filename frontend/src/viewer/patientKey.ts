/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 「同じ患者か」を決める鍵。
 *
 * <p>ROI の永続化（`/api/rois?patientKey=`）・プラグイン保存領域・位置合わせ記録が
 * すべてこの鍵で引く。**規則が 2 か所に割れると「その患者だけ ROI が出ない」**という、
 * 画面に何も出ないまま起きる事故になるので、導出はここ 1 本に閉じる。
 *
 * <p>⚠ PatientID には `/` が普通に入る（実データ `D97258/11053`）。この鍵を URL に載せる
 * ときは**必ずクエリ**で渡すこと（パスに入れると `%2F` でも Tomcat が 400 を返す）。
 * 詳細は `fw/roi-manager-design.md` §11.1。
 */
import type { Study } from "../api";

/** PatientID → PatientName → StudyInstanceUID の順に採る。 */
export function derivePatientKey(study: Study): string {
  return study.patientId || study.patientName || study.studyInstanceUid;
}

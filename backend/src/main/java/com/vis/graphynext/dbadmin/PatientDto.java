package com.vis.graphynext.dbadmin;

/**
 * 患者テーブルの 1 行（ローカル索引の集計）。
 */
public record PatientDto(String patientId, String patientName, String patientBirthDate,
                         String patientSex, long numberOfStudies, long numberOfInstances) {
}

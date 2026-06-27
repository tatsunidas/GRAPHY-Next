package com.vis.graphynext.dicom;

/**
 * スタディ一覧の 1 行。standalone（H2 索引）と web（QIDO）の双方で共通に使う UI 向け DTO。
 *
 * @param studyInstanceUid   Study Instance UID
 * @param patientId          患者 ID
 * @param patientName        患者名（standalone は索引に未保持のため null のことがある）
 * @param numberOfInstances  そのスタディに属するインスタンス数
 */
public record StudyDto(String studyInstanceUid, String patientId, String patientName, long numberOfInstances) {
}

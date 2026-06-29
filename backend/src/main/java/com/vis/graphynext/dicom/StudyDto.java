/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

/**
 * スタディ一覧の 1 行。standalone（H2 索引）と web（QIDO）の双方で共通に使う UI 向け DTO。
 */
public record StudyDto(String studyInstanceUid, String patientId, String patientName,
                       String studyDate, String studyDescription, String modality,
                       long numberOfInstances) {
}

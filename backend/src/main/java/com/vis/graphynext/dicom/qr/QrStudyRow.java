/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

/**
 * QR ウィンドウの STUDY 行（リモート PACS への C-FIND 結果）。
 *
 * <p>年齢は frontend が {@code studyDate} と {@code patientBirthDate} から算出するため持たない。
 */
public record QrStudyRow(
        String studyInstanceUid,
        String patientId,
        String patientName,
        String patientBirthDate,
        String patientSex,
        String studyDate,
        String studyDescription,
        String accessionNumber,
        String modality,
        int numberOfStudyRelatedSeries,
        int numberOfStudyRelatedInstances) {
}

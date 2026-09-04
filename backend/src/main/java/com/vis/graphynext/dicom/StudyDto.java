/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import java.util.List;

/**
 * スタディ一覧の 1 行。standalone（H2 索引）と web（QIDO）の双方で共通に使う UI 向け DTO。
 */
public record StudyDto(String studyInstanceUid, String patientId, String patientName,
                       String studyDate, String studyDescription, String modality,
                       long numberOfInstances, List<String> modalities) {

    /**
     * {@code modalities} が分からない経路向け（{@code modality} 1 つを列挙とみなす）。
     *
     * <p>★ {@code modality} は<b>残す</b>。検索の絞り込みキーとして使われており、意味を
     * 変えると絞り込みが黙って壊れる。表示用の列挙は {@code modalities} に足す。
     */
    public StudyDto(String studyInstanceUid, String patientId, String patientName,
                    String studyDate, String studyDescription, String modality,
                    long numberOfInstances) {
        this(studyInstanceUid, patientId, patientName, studyDate, studyDescription, modality,
                numberOfInstances,
                modality == null || modality.isBlank() ? List.of() : List.of(modality));
    }
}

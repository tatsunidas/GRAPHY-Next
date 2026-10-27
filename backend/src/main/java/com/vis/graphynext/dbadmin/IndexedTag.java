/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.vis.graphynext.dicom.store.DicomInstance;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;

import java.util.Objects;
import java.util.Optional;

/**
 * 索引（{@link DicomInstance}）に写しがある、タグの編集で変えられるタグ。患者タグは患者情報の編集が受け持つので含めない。
 * 値は取り込み（{@code DicomStorageService}）と同じ形にする: 文字列は {@code getString}、番号は {@code getInt(tag, 0)}。
 */
enum IndexedTag {
    STUDY_DATE(Tag.StudyDate, false),
    STUDY_DESCRIPTION(Tag.StudyDescription, false),
    ACCESSION_NUMBER(Tag.AccessionNumber, false),
    MODALITY(Tag.Modality, false),
    SERIES_NUMBER(Tag.SeriesNumber, true),
    SERIES_DESCRIPTION(Tag.SeriesDescription, false),
    INSTANCE_NUMBER(Tag.InstanceNumber, true),
    STUDY_TIME(Tag.StudyTime, false),
    STUDY_ID(Tag.StudyID, false),
    REFERRING_PHYSICIAN_NAME(Tag.ReferringPhysicianName, false);

    final int tag;
    private final boolean integer;

    IndexedTag(int tag, boolean integer) {
        this.tag = tag;
        this.integer = integer;
    }

    static Optional<IndexedTag> of(int tag) {
        for (IndexedTag t : values()) {
            if (t.tag == tag) {
                return Optional.of(t);
            }
        }
        return Optional.empty();
    }

    /** ファイルの値（索引に入れる形）。 */
    Object fromFile(Attributes ds) {
        if (integer) {
            return ds.getInt(tag, 0);
        }
        return ds.getString(tag);
    }

    Object fromRow(DicomInstance r) {
        return switch (this) {
            case STUDY_DATE -> r.getStudyDate();
            case STUDY_DESCRIPTION -> r.getStudyDescription();
            case ACCESSION_NUMBER -> r.getAccessionNumber();
            case MODALITY -> r.getModality();
            case SERIES_NUMBER -> r.getSeriesNumber();
            case SERIES_DESCRIPTION -> r.getSeriesDescription();
            case INSTANCE_NUMBER -> r.getInstanceNumber();
            case STUDY_TIME -> r.getStudyTime();
            case STUDY_ID -> r.getStudyId();
            case REFERRING_PHYSICIAN_NAME -> r.getReferringPhysicianName();
        };
    }

    void toRow(DicomInstance r, Attributes ds) {
        Object v = fromFile(ds);
        switch (this) {
            case STUDY_DATE -> r.setStudyDate((String) v);
            case STUDY_DESCRIPTION -> r.setStudyDescription((String) v);
            case ACCESSION_NUMBER -> r.setAccessionNumber((String) v);
            case MODALITY -> r.setModality((String) v);
            case SERIES_NUMBER -> r.setSeriesNumber((Integer) v);
            case SERIES_DESCRIPTION -> r.setSeriesDescription((String) v);
            case INSTANCE_NUMBER -> r.setInstanceNumber((Integer) v);
            // 値を消したときは null でなく空文字（null は「まだ読んでいない行」の印なので戻さない）
            case STUDY_TIME -> r.setStudyTime(emptyIfNull((String) v));
            case STUDY_ID -> r.setStudyId(emptyIfNull((String) v));
            case REFERRING_PHYSICIAN_NAME -> r.setReferringPhysicianName(emptyIfNull((String) v));
        }
    }

    boolean matches(DicomInstance r, Attributes ds) {
        return Objects.equals(norm(fromRow(r)), norm(fromFile(ds)));
    }

    private static String emptyIfNull(String v) {
        return v == null ? "" : v;
    }

    private static Object norm(Object v) {
        return (v instanceof String s && s.isEmpty()) ? null : v;
    }
}

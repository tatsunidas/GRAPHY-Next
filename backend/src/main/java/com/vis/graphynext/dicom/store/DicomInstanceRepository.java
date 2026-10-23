/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;

/**
 * ローカル索引のリポジトリ。
 *
 * <p>マッチングは入れ子ループ＋複数 DB 往復ではなく、null 許容パラメータの
 * <b>1 本のクエリ</b>で行う（方針③）。各レベルの UID は null のとき無条件（ワイルドカード）。
 */
public interface DicomInstanceRepository extends JpaRepository<DicomInstance, String> {

    @Query("""
            select i from DicomInstance i
            where (:patientId is null or i.patientId = :patientId)
              and (:studyUid  is null or i.studyInstanceUid = :studyUid)
              and (:seriesUid is null or i.seriesInstanceUid = :seriesUid)
              and (:sopUid    is null or i.sopInstanceUid = :sopUid)
            """)
    List<DicomInstance> findMatches(@Param("patientId") String patientId,
                                    @Param("studyUid") String studyUid,
                                    @Param("seriesUid") String seriesUid,
                                    @Param("sopUid") String sopUid);

    /** スタディ単位の集計（一覧表示用・絞り込み可。各パラメータは null で無条件）。 */
    @Query("""
            select i.studyInstanceUid as studyInstanceUid,
                   i.patientId as patientId,
                   max(i.patientName) as patientName,
                   max(i.studyDate) as studyDate,
                   max(i.studyDescription) as studyDescription,
                   max(i.modality) as modality,
                   count(i) as numberOfInstances,
                   sum(i.numberOfFrames) as framesSum,
                   count(i.numberOfFrames) as framesKnown
            from DicomInstance i
            where (:patientId is null or lower(i.patientId) like lower(concat('%', :patientId, '%')))
              and (:patientName is null or lower(i.patientName) like lower(concat('%', :patientName, '%')))
              and (:studyDateFrom is null or i.studyDate >= :studyDateFrom)
              and (:studyDateTo is null or i.studyDate <= :studyDateTo)
              and (:filterModality = false or i.modality in :modalities)
              and (:accessionNumber is null or i.accessionNumber = :accessionNumber)
            group by i.studyInstanceUid, i.patientId
            order by max(i.studyDate) desc
            """)
    List<StudySummary> findStudySummaries(@Param("patientId") String patientId,
                                          @Param("patientName") String patientName,
                                          @Param("studyDateFrom") String studyDateFrom,
                                          @Param("studyDateTo") String studyDateTo,
                                          @Param("filterModality") boolean filterModality,
                                          @Param("modalities") List<String> modalities,
                                          @Param("accessionNumber") String accessionNumber);

    /**
     * スタディごとの<b>重複なしモダリティ</b>。
     *
     * <p>スタディ一覧の表示に使う。集計行の {@code max(i.modality)} は 1 つしか返せないため、
     * CT/PT/NM を持つスタディが "PT" だけに見えてしまう（MRTDosimetry の実データで踏んだ）。
     */
    @Query("""
            select distinct i.studyInstanceUid as studyUid, i.modality as modality
            from DicomInstance i
            where i.studyInstanceUid in :studyUids and i.modality is not null
            """)
    List<StudyModality> findStudyModalities(@Param("studyUids") List<String> studyUids);

    /** findStudyModalities の射影。 */
    interface StudyModality {
        String getStudyUid();

        String getModality();
    }

    /** スタディ内のシリーズ単位の集計。 */
    @Query("""
            select i.seriesInstanceUid as seriesInstanceUid,
                   max(i.modality) as modality,
                   max(i.seriesNumber) as seriesNumber,
                   max(i.seriesDescription) as seriesDescription,
                   max(i.sopClassUid) as sopClassUid,
                   count(i) as numberOfInstances,
                   sum(i.numberOfFrames) as framesSum,
                   count(i.numberOfFrames) as framesKnown
            from DicomInstance i
            where i.studyInstanceUid = :studyUid
            group by i.seriesInstanceUid
            order by max(i.seriesNumber)
            """)
    List<SeriesSummary> findSeriesSummaries(@Param("studyUid") String studyUid);

    /** シリーズ内のインスタンス（InstanceNumber 順）。 */
    @Query("""
            select i from DicomInstance i
            where i.studyInstanceUid = :studyUid and i.seriesInstanceUid = :seriesUid
            order by i.instanceNumber
            """)
    List<DicomInstance> findBySeries(@Param("studyUid") String studyUid, @Param("seriesUid") String seriesUid);

    /**
     * 複数スタディのシリーズ（枚数つき）を 1 回で引く。スタディごとに問い合わせる N+1 を避ける。
     * 呼び出し側は IN 句の長さを抑えるため、スタディ UID を数百件ずつのチャンクで渡す。
     */
    @Query("""
            select i.studyInstanceUid as studyUid, i.seriesInstanceUid as seriesUid, count(i) as instances
            from DicomInstance i
            where i.studyInstanceUid in :studyUids
            group by i.studyInstanceUid, i.seriesInstanceUid
            order by i.studyInstanceUid, max(i.seriesNumber), i.seriesInstanceUid
            """)
    List<SeriesRef> findSeriesRefs(@Param("studyUids") List<String> studyUids);

    /** findSeriesRefs の射影。 */
    interface SeriesRef {
        String getStudyUid();

        String getSeriesUid();

        long getInstances();
    }

    /**
     * シリーズの代表ヘッダ候補。画像でない SOP（SC・SR/KO・PR・PDF）を後ろへ回し、次に InstanceNumber 順。
     * 呼び出し側は Pageable で先頭数件だけ取る（1000 枚のシリーズの実体を全部読まないため）。
     */
    @Query("""
            select i from DicomInstance i
            where i.studyInstanceUid = :studyUid and i.seriesInstanceUid = :seriesUid
            order by case when i.sopClassUid is null
                            or i.sopClassUid = '1.2.840.10008.5.1.4.1.1.7' or i.sopClassUid like '1.2.840.10008.5.1.4.1.1.7.%'
                            or i.sopClassUid = '1.2.840.10008.5.1.4.1.1.88' or i.sopClassUid like '1.2.840.10008.5.1.4.1.1.88.%'
                            or i.sopClassUid = '1.2.840.10008.5.1.4.1.1.11' or i.sopClassUid like '1.2.840.10008.5.1.4.1.1.11.%'
                            or i.sopClassUid = '1.2.840.10008.5.1.4.1.1.104' or i.sopClassUid like '1.2.840.10008.5.1.4.1.1.104.%'
                          then 1 else 0 end,
                     i.instanceNumber
            """)
    List<DicomInstance> findCandidates(@Param("studyUid") String studyUid, @Param("seriesUid") String seriesUid,
                                       org.springframework.data.domain.Pageable page);

    // --- 患者テーブル（DB 管理 UI 用）---

    /** 患者単位の集計（検索可。q が null/空なら全件）。 */
    @Query("""
            select i.patientId as patientId,
                   max(i.patientName) as patientName,
                   max(i.patientBirthDate) as patientBirthDate,
                   max(i.patientSex) as patientSex,
                   count(distinct i.studyInstanceUid) as numberOfStudies,
                   count(i) as numberOfInstances
            from DicomInstance i
            where (:q is null or lower(i.patientId) like lower(concat('%', :q, '%'))
                              or lower(i.patientName) like lower(concat('%', :q, '%')))
            group by i.patientId
            order by max(i.patientName)
            """)
    List<PatientSummary> findPatientSummaries(@Param("q") String q);

    List<DicomInstance> findByPatientId(String patientId);

    /** NumberOfFrames を保存する前に取り込んだ行（起動時の埋め直し用）。 */
    List<DicomInstance> findByNumberOfFramesIsNull();

    List<DicomInstance> findByStudyInstanceUid(String studyUid);

    /** スタディ単位のローカル保存インスタンス数（QR の保存済み判定）。 */
    long countByStudyInstanceUid(String studyUid);

    /** シリーズ単位のローカル保存インスタンス数（QR の保存済み判定）。 */
    long countByStudyInstanceUidAndSeriesInstanceUid(String studyUid, String seriesUid);

    // --- 統計 ---

    @Query("""
            select substring(i.studyDate, 1, 6) as k, count(distinct i.studyInstanceUid) as v
            from DicomInstance i
            where i.studyDate is not null and length(i.studyDate) >= 6
            group by substring(i.studyDate, 1, 6)
            order by k
            """)
    List<KeyValue> studyCountByMonth();

    @Query("""
            select i.modality as k, count(distinct i.studyInstanceUid) as v
            from DicomInstance i group by i.modality order by v desc
            """)
    List<KeyValue> studyCountByModality();

    @Query("""
            select i.modality as k, count(i) as v
            from DicomInstance i group by i.modality order by v desc
            """)
    List<KeyValue> instanceCountByModality();

    @Query("""
            select i.modality as k, coalesce(sum(i.sizeBytes), 0) as v
            from DicomInstance i group by i.modality order by v desc
            """)
    List<KeyValue> volumeBytesByModality();

    /** 患者集計の射影。 */
    interface PatientSummary {
        String getPatientId();

        String getPatientName();

        String getPatientBirthDate();

        String getPatientSex();

        long getNumberOfStudies();

        long getNumberOfInstances();
    }

    /** 統計の汎用 {キー, 値} 射影。 */
    interface KeyValue {
        String getK();

        long getV();
    }

    /** findStudySummaries の射影。 */
    interface StudySummary {
        String getStudyInstanceUid();

        String getPatientId();

        String getPatientName();

        String getStudyDate();

        String getStudyDescription();

        String getModality();

        long getNumberOfInstances();

        /** フレーム数の合計。NumberOfFrames が未取得（null）の行は含まれない（全行が取得済みかは {@link #getFramesKnown()}）。 */
        Long getFramesSum();

        /** NumberOfFrames が取得済みの行数。{@code getNumberOfInstances()} と等しいときだけ合計が全体を表す。 */
        long getFramesKnown();
    }

    /** findSeriesSummaries の射影。 */
    interface SeriesSummary {
        String getSeriesInstanceUid();

        String getModality();

        Integer getSeriesNumber();

        String getSeriesDescription();

        /**
         * 代表インスタンスの SOP クラス。フロントが「画像として開けるシリーズか」を判定するのに使う
         * （RTSTRUCT / SR / PR 等はピクセルを持たない）。1 シリーズ内で混在は想定しないため max で代表を採る。
         */
        String getSopClassUid();

        long getNumberOfInstances();

        /** フレーム数の合計。NumberOfFrames が未取得（null）の行は含まれない（全行が取得済みかは {@link #getFramesKnown()}）。 */
        Long getFramesSum();

        /** NumberOfFrames が取得済みの行数。{@code getNumberOfInstances()} と等しいときだけ合計が全体を表す。 */
        long getFramesKnown();
    }
}

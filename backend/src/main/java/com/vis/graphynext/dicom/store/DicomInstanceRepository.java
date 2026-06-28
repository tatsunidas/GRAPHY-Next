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
                   count(i) as numberOfInstances
            from DicomInstance i
            where (:patientId is null or lower(i.patientId) like lower(concat('%', :patientId, '%')))
              and (:patientName is null or lower(i.patientName) like lower(concat('%', :patientName, '%')))
              and (:studyDate is null or i.studyDate = :studyDate)
              and (:modality is null or i.modality = :modality)
              and (:accessionNumber is null or i.accessionNumber = :accessionNumber)
            group by i.studyInstanceUid, i.patientId
            order by max(i.studyDate) desc
            """)
    List<StudySummary> findStudySummaries(@Param("patientId") String patientId,
                                          @Param("patientName") String patientName,
                                          @Param("studyDate") String studyDate,
                                          @Param("modality") String modality,
                                          @Param("accessionNumber") String accessionNumber);

    /** スタディ内のシリーズ単位の集計。 */
    @Query("""
            select i.seriesInstanceUid as seriesInstanceUid,
                   max(i.modality) as modality,
                   max(i.seriesNumber) as seriesNumber,
                   max(i.seriesDescription) as seriesDescription,
                   count(i) as numberOfInstances
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

    List<DicomInstance> findByStudyInstanceUid(String studyUid);

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
    }

    /** findSeriesSummaries の射影。 */
    interface SeriesSummary {
        String getSeriesInstanceUid();

        String getModality();

        Integer getSeriesNumber();

        String getSeriesDescription();

        long getNumberOfInstances();
    }
}

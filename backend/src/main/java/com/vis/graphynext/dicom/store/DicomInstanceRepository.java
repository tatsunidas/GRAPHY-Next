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

    /** スタディ単位の集計（一覧表示用）。 */
    @Query("""
            select i.studyInstanceUid as studyInstanceUid,
                   i.patientId as patientId,
                   max(i.patientName) as patientName,
                   max(i.studyDate) as studyDate,
                   max(i.studyDescription) as studyDescription,
                   max(i.modality) as modality,
                   count(i) as numberOfInstances
            from DicomInstance i
            group by i.studyInstanceUid, i.patientId
            order by max(i.studyDate) desc
            """)
    List<StudySummary> findStudySummaries();

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

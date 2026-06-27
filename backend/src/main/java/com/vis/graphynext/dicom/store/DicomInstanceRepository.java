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
}

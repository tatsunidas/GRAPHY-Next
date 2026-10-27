/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.roi.RoiMaskDocument;
import com.vis.graphynext.roi.RoiMaskDocumentRepository;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 保存済みの塗り ROI（{@code roi_mask_document}）を、画像の削除・患者の編集に合わせて片付ける・付け替える。
 * 主眼は「消すべきものだけ消え、残すべきものは残る」こと（負例を必ず見る）。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:maskorphan;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class MaskOrphanCleanupTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DbAdminService dbAdmin;
    @Autowired
    DicomStorageService storage;
    @Autowired
    RoiMaskDocumentRepository masks;

    private final ObjectMapper mapper = new ObjectMapper();

    private void ingest(String pid, String study, String series, String sop) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage(pid, study, series, sop);
        ds.setString(Tag.PatientName, VR.PN, pid + "^N");
        storage.ingest(DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian));
    }

    private static String meta(String patientKey, String studyUid) {
        return "{\"patientKey\":\"" + patientKey + "\",\"label\":\"ROI\",\"origin\":{\"studyUid\":\"" + studyUid
                + "\",\"seriesUid\":\"x\"},\"scope\":{\"studyUid\":\"" + studyUid + "\"}}";
    }

    private void mask(String uid, String patientKey, String studyUid, String seriesUid) {
        masks.save(new RoiMaskDocument(uid, patientKey, seriesUid, meta(patientKey, studyUid), new byte[] {1, 2, 3}, 1));
    }

    private Set<String> uidsOf(String patientKey) {
        return masks.findByPatientKey(patientKey).stream().map(RoiMaskDocument::getMaskUid).collect(Collectors.toSet());
    }

    @Test
    void シリーズを消すと_そのシリーズの塗り_ROI_だけ消え_同じ患者の別シリーズと別患者は残る() throws Exception {
        ingest("MK1", "mk.a", "mk.a.s1", "mk.a.1");
        ingest("MK1", "mk.a", "mk.a.s2", "mk.a.2");
        ingest("MK2", "mk.b", "mk.b.s1", "mk.b.1");
        mask("m-s1", "MK1", "mk.a", "mk.a.s1");
        mask("m-s2", "MK1", "mk.a", "mk.a.s2");
        mask("m-other", "MK2", "mk.b", "mk.b.s1");

        var r = dbAdmin.deleteSeries("mk.a", "mk.a.s1");

        assertEquals(Set.of("m-s2"), uidsOf("MK1"));
        assertEquals(Set.of("m-other"), uidsOf("MK2"));
        assertEquals(1, r.related().masksRemoved());
    }

    @Test
    void シリーズが残る画像_1_枚の削除では塗り_ROI_は残る() throws Exception {
        ingest("MK3", "mk.c", "mk.c.s", "mk.c.1");
        ingest("MK3", "mk.c", "mk.c.s", "mk.c.2");
        mask("m-keep", "MK3", "mk.c", "mk.c.s");

        var r = dbAdmin.deleteInstance("mk.c", "mk.c.s", "mk.c.1");

        assertEquals(Set.of("m-keep"), uidsOf("MK3"));
        assertEquals(0, r.related().masksRemoved());
    }

    @Test
    void 患者の画像がすべて消えたら_その患者の塗り_ROI_を全部消す_シリーズが索引に無いものも() throws Exception {
        ingest("MK4", "mk.d", "mk.d.s", "mk.d.1");
        ingest("MK5", "mk.e", "mk.e.s", "mk.e.1");
        mask("m-4a", "MK4", "mk.d", "mk.d.s");
        mask("m-4ghost", "MK4", "mk.d", "ghost.series"); // 索引に無かったシリーズのもの
        mask("m-5", "MK5", "mk.e", "mk.e.s");

        var r = dbAdmin.deletePatient("MK4");

        assertTrue(uidsOf("MK4").isEmpty(), "患者の塗り ROI は全部消える");
        assertEquals(Set.of("m-5"), uidsOf("MK5"), "別患者のものは残る");
        assertEquals(2, r.related().masksRemoved());
    }

    @Test
    void 保存期間による自動削除でも塗り_ROI_を片付ける() throws Exception {
        ingest("MK6", "mk.f", "mk.f.s", "mk.f.1");
        ingest("MK6", "mk.g", "mk.g.s", "mk.g.1");
        mask("m-f", "MK6", "mk.f", "mk.f.s");
        mask("m-g", "MK6", "mk.g", "mk.g.s");

        var r = dbAdmin.deleteStudyForRetention("mk.f");

        assertEquals(Set.of("m-g"), uidsOf("MK6"));
        assertEquals(1, r.cleanup().masksRemoved());
    }

    @Test
    void 患者_ID_の変更で患者全体が移るとき_塗り_ROI_の行とメタの患者キーを付け替える_画素とシリーズは変えない() throws Exception {
        ingest("MK7", "mk.h", "mk.h.s", "mk.h.1");
        mask("m-h", "MK7", "mk.h", "mk.h.s");

        var r = dbAdmin.updatePatient("MK7", "MK8^N", "", "", "MK8").records();

        assertTrue(uidsOf("MK7").isEmpty());
        RoiMaskDocument moved = masks.findById("m-h").orElseThrow();
        assertEquals("MK8", moved.getPatientKey());
        assertEquals("MK8", mapper.readTree(moved.getMeta()).path("patientKey").asText(), "メタの患者キーも書き換える");
        assertEquals("mk.h.s", moved.getSeriesUid());
        assertArrayEquals(new byte[] {1, 2, 3}, moved.getFrames());
        assertEquals(1, r.masksMoved());
    }

    @Test
    void 検査_1_件だけの移動では_その検査の塗り_ROI_だけ移り_残った検査のものは動かない() throws Exception {
        ingest("MK9", "mk.i", "mk.i.s", "mk.i.1");
        ingest("MK9", "mk.j", "mk.j.s", "mk.j.1");
        mask("m-i", "MK9", "mk.i", "mk.i.s");
        mask("m-j", "MK9", "mk.j", "mk.j.s");

        var r = dbAdmin.updateStudyPatient("mk.i", "MK10^N", "", "", "MK10").records();

        assertEquals(Set.of("m-i"), uidsOf("MK10"));
        assertEquals(Set.of("m-j"), uidsOf("MK9"), "残った検査のものは元のキーのまま");
        assertEquals("MK10", mapper.readTree(masks.findById("m-i").orElseThrow().getMeta()).path("patientKey").asText());
        assertEquals("MK9", mapper.readTree(masks.findById("m-j").orElseThrow().getMeta()).path("patientKey").asText());
        assertEquals(1, r.masksMoved());
    }

    @Test
    void 塗り_ROI_が無い患者の編集と削除は何も壊さない() throws Exception {
        ingest("MK11", "mk.k", "mk.k.s", "mk.k.1");
        var edit = dbAdmin.updatePatient("MK11", "MK12^N", "", "", "MK12").records();
        assertEquals(0, edit.masksMoved());
        var del = dbAdmin.deletePatient("MK12");
        assertEquals(0, del.related().masksRemoved());
        assertFalse(masks.findAll().stream().anyMatch(m -> List.of("MK11", "MK12").contains(m.getPatientKey())));
    }
}

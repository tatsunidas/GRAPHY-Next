/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.report;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.server.ResponseStatusException;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * レポート確定（Comprehensive SR 化・取込）を検証する（`fw/report-design.md` R2）。
 * standalone（ローカル索引＋FS）前提、DicomPhantomFactory でスタディを用意する。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:reportfinalize;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
@ActiveProfiles("standalone")
class ReportFinalizeServiceTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    ReportService reportService;
    @Autowired
    DicomStorageService storage;
    @Autowired
    DicomInstanceRepository dicomInstanceRepo;

    @Test
    void finalizeReport_buildsComprehensiveSrAndIngestsIt() throws Exception {
        String studyUid = "STUDY.FIN1";
        String seriesUid = "SERIES.FIN1";
        String sopUid = "SOP.FIN1";
        Attributes ds = DicomPhantomFactory.scImage("PIDF1", studyUid, seriesUid, sopUid);
        ds.setString(Tag.SpecificCharacterSet, org.dcm4che3.data.VR.CS, "ISO_IR 192");
        ds.setString(Tag.PatientName, org.dcm4che3.data.VR.PN, "山田^一郎");
        storage.ingest(DicomPhantomFactory.writeFile(
                Files.createTempFile("phantom", ".dcm"), ds, UID.ExplicitVRLittleEndian));

        ReportDto created = reportService.create(new CreateReportRequest(
                "PIDF1", studyUid, "胸部CT 読影レポート",
                ReportType.IMAGING_DIAGNOSTIC, "既往歴なし",
                "紹介医", "## 所見\n\n**異常なし**。"));
        reportService.update(created.id(), new UpdateReportRequest(
                null, null, null, null,
                List.of(new UpdateReportRequest.ParticipantInput(
                        "医師太郎", StaffRole.PHYSICIAN, ParticipationType.AUTHOR, "放射線科")),
                null, null));

        ReportDto finalized = reportService.finalizeReport(created.id());

        assertEquals(ReportStatus.FINAL, finalized.status());
        assertNotNull(finalized.srSopInstanceUid());
        assertNotNull(finalized.seriesInstanceUid());

        Optional<DicomInstance> srInstance = dicomInstanceRepo.findById(finalized.srSopInstanceUid());
        assertTrue(srInstance.isPresent(), "SR が取込パイプラインへ登録されていること");
        assertEquals(UID.ComprehensiveSRStorage, srInstance.get().getSopClassUid());
        assertEquals(studyUid, srInstance.get().getStudyInstanceUid());
        assertEquals("SR", srInstance.get().getModality());

        Attributes srDataset = readHeader(Path.of(java.net.URI.create(srInstance.get().getUri())));
        assertEquals("山田^一郎", srDataset.getString(Tag.PatientName), "参照インスタンスから患者名を継承");
        assertEquals("CONTAINER", srDataset.getString(Tag.ValueType));
        assertEquals("UNVERIFIED", srDataset.getString(Tag.VerificationFlag), "VERIFIER 参加者が無いので未検証");

        List<Attributes> content = readContentSequence(srDataset);
        boolean hasBody = content.stream().anyMatch(item ->
                "TEXT".equals(item.getString(Tag.ValueType))
                        && item.getString(Tag.TextValue) != null
                        && item.getString(Tag.TextValue).contains("異常なし"));
        assertTrue(hasBody, "Markdown 本文が平文化されて TEXT content item に入っていること: " + content);

        Attributes authorItem = srDataset.getNestedDataset(Tag.AuthorObserverSequence);
        assertNotNull(authorItem, "AUTHOR 参加者が Author Observer Sequence に入っていること");
        assertEquals("医師太郎", authorItem.getString(Tag.PersonName));
    }

    @Test
    void finalizeReport_withKeyImages_alsoGeneratesKeyObjectSelectionDocument() throws Exception {
        String studyUid = "STUDY.FIN4";
        String seriesUid = "SERIES.FIN4";
        Attributes refDs = DicomPhantomFactory.scImage("PIDF4", studyUid, seriesUid, "SOP.FIN4.REF");
        storage.ingest(DicomPhantomFactory.writeFile(
                Files.createTempFile("phantom", ".dcm"), refDs, UID.ExplicitVRLittleEndian));
        Attributes keyDs = DicomPhantomFactory.scImage("PIDF4", studyUid, seriesUid, "SOP.FIN4.KEY");
        storage.ingest(DicomPhantomFactory.writeFile(
                Files.createTempFile("phantom", ".dcm"), keyDs, UID.ExplicitVRLittleEndian));

        ReportDto created = reportService.create(new CreateReportRequest(
                "PIDF4", studyUid, "title", null, null, null, "所見あり"));
        reportService.update(created.id(), new UpdateReportRequest(
                null, null, null, null, null,
                List.of(new UpdateReportRequest.KeyImageInput(
                        "SOP.FIN4.KEY", seriesUid, null, "key1", "注目領域", 0)),
                null));

        ReportDto finalized = reportService.finalizeReport(created.id());

        assertNotNull(finalized.koSopInstanceUid(), "キー画像があれば KO も生成される");
        assertNotNull(finalized.koSeriesInstanceUid());

        Optional<DicomInstance> koInstance = dicomInstanceRepo.findById(finalized.koSopInstanceUid());
        assertTrue(koInstance.isPresent(), "KO が取込パイプラインへ登録されていること");
        assertEquals(UID.KeyObjectSelectionDocumentStorage, koInstance.get().getSopClassUid());
        assertEquals("KO", koInstance.get().getModality());

        Attributes koDataset = readHeader(Path.of(java.net.URI.create(koInstance.get().getUri())));
        assertEquals("CONTAINER", koDataset.getString(Tag.ValueType));
        Attributes koConcept = koDataset.getNestedDataset(Tag.ConceptNameCodeSequence);
        assertEquals("113000", koConcept.getString(Tag.CodeValue));
        assertEquals("Of Interest", koConcept.getString(Tag.CodeMeaning));

        List<Attributes> koContent = readContentSequence(koDataset);
        assertEquals(1, koContent.size());
        Attributes imageRef = koContent.get(0).getNestedDataset(Tag.ReferencedSOPSequence);
        assertEquals("SOP.FIN4.KEY", imageRef.getString(Tag.ReferencedSOPInstanceUID));

        // KO には CompletionFlag/VerificationFlag/Observer 系は含めない（Key Object Document Module に無い）。
        assertTrue(koDataset.getString(Tag.CompletionFlag) == null);
        assertTrue(koDataset.getString(Tag.VerificationFlag) == null);

        // SR 側の ContentSequence にも同じキー画像が IMAGE として入っていること。
        Optional<DicomInstance> srInstance = dicomInstanceRepo.findById(finalized.srSopInstanceUid());
        Attributes srDataset = readHeader(Path.of(java.net.URI.create(srInstance.orElseThrow().getUri())));
        boolean srHasKeyImage = readContentSequence(srDataset).stream().anyMatch(item ->
                "IMAGE".equals(item.getString(Tag.ValueType))
                        && "SOP.FIN4.KEY".equals(item.getNestedDataset(Tag.ReferencedSOPSequence).getString(Tag.ReferencedSOPInstanceUID)));
        assertTrue(srHasKeyImage, "SR 本文にもキー画像が IMAGE content item として入っていること");
    }

    @Test
    void finalizeReport_rejectsWhenAlreadyFinal() throws Exception {
        String studyUid = "STUDY.FIN2";
        Attributes ds = DicomPhantomFactory.scImage("PIDF2", studyUid, "SERIES.FIN2", "SOP.FIN2");
        storage.ingest(DicomPhantomFactory.writeFile(
                Files.createTempFile("phantom", ".dcm"), ds, UID.ExplicitVRLittleEndian));

        ReportDto created = reportService.create(new CreateReportRequest(
                "PIDF2", studyUid, "title", null, null, null, "body"));
        reportService.finalizeReport(created.id());

        assertThrows(ResponseStatusException.class, () -> reportService.finalizeReport(created.id()));
    }

    @Test
    void finalizeReport_rejectsWhenNoBodyAndNoKeyImages() throws Exception {
        String studyUid = "STUDY.FIN3";
        Attributes ds = DicomPhantomFactory.scImage("PIDF3", studyUid, "SERIES.FIN3", "SOP.FIN3");
        storage.ingest(DicomPhantomFactory.writeFile(
                Files.createTempFile("phantom", ".dcm"), ds, UID.ExplicitVRLittleEndian));

        ReportDto created = reportService.create(new CreateReportRequest(
                "PIDF3", studyUid, "title", null, null, null, null));

        assertThrows(ResponseStatusException.class, () -> reportService.finalizeReport(created.id()));
    }

    private static Attributes readHeader(Path p) throws Exception {
        try (DicomInputStream in = new DicomInputStream(p.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            return in.readDataset();
        }
    }

    @SuppressWarnings("unchecked")
    private static List<Attributes> readContentSequence(Attributes srDataset) {
        var seq = srDataset.getSequence(Tag.ContentSequence);
        return seq == null ? List.of() : List.copyOf(seq);
    }
}

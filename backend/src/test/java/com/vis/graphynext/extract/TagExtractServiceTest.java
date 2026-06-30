/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.extract;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * TagExtractService のパス解決（シーケンス／Private／複数値）と代表シリーズ抽出を検証する。
 * standalone（ローカル索引＋FS）前提。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:tagextract;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
@ActiveProfiles("standalone")
class TagExtractServiceTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DicomStorageService storage;
    @Autowired
    TagExtractService service;

    @Test
    void extractTable_resolvesSequencePrivateAndMultiValue() throws Exception {
        Attributes ds = DicomPhantomFactory.scImage("PIDX", "ST.TE", "SE.TE", "SOP.TE");
        ds.setString(Tag.AccessionNumber, VR.SH, "ACC1");
        // 複数値（VM>1）
        ds.setString(Tag.ImageType, VR.CS, "DERIVED", "SECONDARY");
        // シーケンス: RequestAttributesSequence(0040,0275) > ScheduledProcedureStepID(0040,0009)
        Attributes item = new Attributes();
        item.setString(Tag.ScheduledProcedureStepID, VR.SH, "SPS123");
        Sequence seq = ds.newSequence(Tag.RequestAttributesSequence, 1);
        seq.add(item);
        // Private タグ: creator "VIS-PRIVATE" の (0019,xx01)
        ds.setString("VIS-PRIVATE", 0x00190001, VR.LO, "PRIVVAL");

        Path f = DicomPhantomFactory.writeFile(Files.createTempFile("phantom", ".dcm"), ds, UID.ExplicitVRLittleEndian);
        storage.ingest(f);

        List<TagExtractService.TagPath> paths = List.of(
                new TagExtractService.TagPath(List.of(new TagExtractService.Seg("00100010", null)), "PatientName"),
                new TagExtractService.TagPath(List.of(new TagExtractService.Seg("00080008", null)), "ImageType"),
                new TagExtractService.TagPath(List.of(
                        new TagExtractService.Seg("00400275", null),
                        new TagExtractService.Seg("00400009", null)), "RequestAttributes.SPSID"),
                new TagExtractService.TagPath(List.of(new TagExtractService.Seg("00190001", "VIS-PRIVATE")), "Private"));

        TagExtractService.TableResult r = service.extractTable(List.of("ST.TE"), paths);

        assertEquals(1, r.rows().size(), "シリーズ代表 1 行");
        List<String> cols = r.columns();
        List<String> row = r.rows().get(0);

        assertEquals("PHANTOM^TEST", row.get(cols.indexOf("PatientName")), "トップレベルタグ");
        assertEquals("DERIVED\\SECONDARY", row.get(cols.indexOf("ImageType")), "複数値は \\ 連結");
        assertEquals("SPS123", row.get(cols.indexOf("RequestAttributes.SPSID")), "シーケンス内タグ");
        assertEquals("PRIVVAL", row.get(cols.indexOf("Private")), "Private タグ（creator 指定）");

        // 管理列
        assertEquals("PIDX", row.get(cols.indexOf("PatientID")));
        assertEquals("ACC1", row.get(cols.indexOf("AccessionNumber")));
        assertEquals("ST.TE", row.get(cols.indexOf("StudyInstanceUID")));
        assertEquals("SE.TE", row.get(cols.indexOf("SeriesInstanceUID")));
        assertTrue(r.errors().isEmpty(), () -> "エラーなし: " + r.errors());
    }

    @Test
    void extractTable_missingPathYieldsEmpty_notError() throws Exception {
        Attributes ds = DicomPhantomFactory.scImage("PIDY", "ST.MISS", "SE.MISS", "SOP.MISS");
        storage.ingest(DicomPhantomFactory.writeFile(
                Files.createTempFile("phantom", ".dcm"), ds, UID.ExplicitVRLittleEndian));

        var paths = List.of(
                new TagExtractService.TagPath(List.of(
                        new TagExtractService.Seg("00400275", null),
                        new TagExtractService.Seg("00400009", null)), "Missing.SPSID"));
        TagExtractService.TableResult r = service.extractTable(List.of("ST.MISS"), paths);
        assertEquals(1, r.rows().size());
        assertEquals("", r.rows().get(0).get(r.columns().indexOf("Missing.SPSID")), "未検出パスは空文字");
    }
}

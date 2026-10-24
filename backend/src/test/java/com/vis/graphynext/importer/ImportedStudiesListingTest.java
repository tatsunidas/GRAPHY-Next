/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.importer;

import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.StudyController;
import com.vis.graphynext.dicom.StudyDto;
import org.dcm4che3.data.UID;
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

/** 取り込み直後の一覧: 返ってきた UID をカンマ区切りで渡すと、その検査だけが（日付の条件なしで）返る。 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:importedlisting;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
@ActiveProfiles("standalone")
class ImportedStudiesListingTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    ImportService importService;
    @Autowired
    StudyController studies;

    @Test
    void importedUids_listOnlyThoseStudies() throws Exception {
        Path root = Files.createDirectories(tmp.resolve("multi"));
        DicomPhantomFactory.writeFile(root.resolve("a.dcm"),
                DicomPhantomFactory.scImage("M1", "1.2.m.studyA", "1.2.m.serA", "1.2.m.sopA"), UID.ExplicitVRLittleEndian);
        DicomPhantomFactory.writeFile(root.resolve("b.dcm"),
                DicomPhantomFactory.scImage("M2", "1.2.m.studyB", "1.2.m.serB", "1.2.m.sopB"), UID.ExplicitVRLittleEndian);
        Path other = DicomPhantomFactory.writeFile(tmp.resolve("other.dcm"),
                DicomPhantomFactory.scImage("M3", "1.2.m.studyC", "1.2.m.serC", "1.2.m.sopC"), UID.ExplicitVRLittleEndian);
        importService.importPaths(List.of(other.toString()));

        ImportService.ImportResult r = importService.importPaths(List.of(root.toString()));
        assertEquals(2, r.studyInstanceUids().size());

        List<String> listed = studies.studies(null, null, null, null, null, null, String.join(",", r.studyInstanceUids()), false)
                .stream().map(StudyDto::studyInstanceUid).sorted().toList();
        assertEquals(List.of("1.2.m.studyA", "1.2.m.studyB"), listed, "取り込んだ検査だけ（別の検査 C は出ない）");
        assertEquals(3, studies.studies(null, null, null, null, null, null, null, false).size(), "条件なしなら 3 件ともある");
    }
}

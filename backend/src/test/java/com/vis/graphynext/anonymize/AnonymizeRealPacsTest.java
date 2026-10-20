/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.io.DicomInputStream;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;
import org.springframework.beans.factory.ObjectProvider;

import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 実物の PACS（dcm4chee 等）での通し確認。環境変数 {@code GRAPHY_REAL_PACS_URL}（DICOMweb の RS ベース URL）が
 * あるときだけ走る（無ければ skip。CI では走らない）。
 *
 * <p>合成スタディを STOW で入れ → web のジョブで匿名化 → ZIP の中身を確かめる。あわせて、WADO-RS が返す
 * 転送構文が保存時のまま（画素が変わらない）であることを確かめる。
 */
class AnonymizeRealPacsTest {

    @TempDir
    Path dir;

    @Test
    void real_pacs_stow_output_rejection_and_compressed_return() throws Exception {
        String url = System.getenv("GRAPHY_REAL_PACS_URL");
        Assumptions.assumeTrue(url != null && !url.isBlank(), "GRAPHY_REAL_PACS_URL 未設定のため実 PACS の確認は skip");
        DicomProperties props = new DicomProperties();
        props.getDicomweb().setBaseUrl(url);
        WebDicomDataService web = new WebDicomDataService(props);
        String root = "1.2.826.0.1.3680043.10.1339." + System.currentTimeMillis();

        // (a) 圧縮（JPEG Baseline）で保存したスタディを WADO-RS が返すときの転送構文
        Path jf = TestDicomFiles.writeJpegBaseline(dir.resolve("j.dcm"), root + ".1", root + ".2", root + ".3", 1, 120);
        web.storeInstances(List.of(Files.readAllBytes(jf)));
        for (int i = 0; i < 20 && web.searchStudyInstances(root + ".1", Map.of()).isEmpty(); i++) {
            Thread.sleep(500);
        }
        byte[] back = web.fetchInstanceUncached(root + ".1", root + ".2", root + ".3");
        try (DicomInputStream in = new DicomInputStream(new ByteArrayInputStream(back))) {
            System.out.println("REAL-PACS compressed stored -> returned transfer syntax = "
                    + in.readFileMetaInformation().getString(Tag.TransferSyntaxUID));
        }

        // (b) PACS が拒否したときの応答の形（壊れた Part-10 を送る）
        try {
            WebDicomDataService.StowResult r = web.storeInstancesChecked(List.of(new byte[] { 1, 2, 3, 4, 5 }));
            System.out.println("REAL-PACS garbage STOW -> result sent=" + r.sent() + " failures=" + r.failures());
        } catch (RuntimeException e) {
            System.out.println("REAL-PACS garbage STOW -> exception " + e.getClass().getSimpleName() + ": " + e.getMessage());
        }

        // (c) STOW 出力のジョブ: 合成スタディ → 匿名化 → 新しいスタディとして PACS へ
        String study = root + ".10";
        String[] sops = { root + ".11", root + ".12", root + ".13" };
        List<Attributes> stored = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            Path f = TestDicomFiles.writeUncompressed(dir.resolve("s" + i + ".dcm"), study, root + ".2" + i, sops[i], 3,
                    100 + 10 * i);
            try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                in.readFileMetaInformation();
                stored.add(in.readDataset());
            }
        }
        web.storeDatasets(stored);
        for (int i = 0; i < 20 && web.searchStudyInstances(study, Map.of()).size() < 3; i++) {
            Thread.sleep(500);
        }
        ObjectProvider<WebDicomDataService> provider = Mockito.mock(ObjectProvider.class);
        Mockito.when(provider.getIfAvailable()).thenReturn(web);
        AnonymizeService svc = new AnonymizeService(Mockito.mock(DicomInstanceRepository.class),
                new AnonymizeMaskStore(), provider, new PixelCodec(props),
                new StorageLayout(Path.of("target", "no-storage-root")));
        AnonymizeJobService jobs = new AnonymizeJobService(svc, web, dir.resolve("jobs"), 2, 60_000);
        try {
            String newPid = "STOWCHK" + System.currentTimeMillis();
            AnonymizeConfig cfg = new AnonymizeConfig();
            cfg.setRandomSeed(7L);
            cfg.setReplacePatientId(newPid);
            String id = jobs.submit(List.of(study), cfg, false, Map.of(), true).jobId();
            AnonymizeJobService.Status st = null;
            for (int i = 0; i < 200; i++) {
                st = jobs.status(id);
                if (st.state() == AnonymizeJobService.State.DONE || st.state() == AnonymizeJobService.State.FAILED) {
                    break;
                }
                Thread.sleep(100);
            }
            assertEquals(AnonymizeJobService.State.DONE, st.state(), st.toString());
            assertEquals(3, st.stored());
            List<Attributes> found = List.of();
            for (int i = 0; i < 20 && found.isEmpty(); i++) {
                found = web.searchStudies(Map.of("PatientID", newPid));
                Thread.sleep(500);
            }
            assertEquals(1, found.size(), "匿名化した新しいスタディが PACS に入った");
            String newStudy = found.get(0).getString(Tag.StudyInstanceUID);
            assertNotEquals(study, newStudy);
            assertEquals(3, web.searchStudyInstances(newStudy, Map.of()).size());
            assertEquals(3, web.searchStudyInstances(study, Map.of()).size(), "元のスタディはそのまま");
        } finally {
            jobs.shutdown();
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void real_pacs_roundtrip() throws Exception {
        String url = System.getenv("GRAPHY_REAL_PACS_URL");
        Assumptions.assumeTrue(url != null && !url.isBlank(), "GRAPHY_REAL_PACS_URL 未設定のため実 PACS の確認は skip");

        String root = "1.2.826.0.1.3680043.10.1338." + System.currentTimeMillis();
        String study = root + ".1";
        String[] series = { root + ".2", root + ".2", root + ".3" };
        String[] sops = { root + ".11", root + ".12", root + ".13" };
        List<Attributes> stored = new ArrayList<>();
        List<byte[]> pixels = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            Path f = TestDicomFiles.writeUncompressed(dir.resolve("in" + i + ".dcm"), study, series[i], sops[i], 3,
                    100 + 10 * i);
            try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                in.readFileMetaInformation();
                Attributes ds = in.readDataset();
                pixels.add(ds.getBytes(Tag.PixelData));
                stored.add(ds);
            }
        }

        DicomProperties props = new DicomProperties();
        props.getDicomweb().setBaseUrl(url);
        WebDicomDataService web = new WebDicomDataService(props);
        web.storeDatasets(stored);
        for (int i = 0; i < 20 && web.searchStudyInstances(study, Map.of()).size() < 3; i++) {
            Thread.sleep(500);
        }
        assertEquals(3, web.searchStudyInstances(study, Map.of()).size(), "PACS に3枚入った");

        // WADO-RS が返す転送構文と画素（キャッシュを通さない取得）
        for (int i = 0; i < 3; i++) {
            byte[] part10 = web.fetchInstanceUncached(study, series[i], sops[i]);
            try (DicomInputStream in = new DicomInputStream(new ByteArrayInputStream(part10))) {
                Attributes fmi = in.readFileMetaInformation();
                Attributes ds = in.readDataset();
                System.out.println("REAL-PACS transfer syntax = " + fmi.getString(Tag.TransferSyntaxUID));
                assertEquals("1.2.840.10008.1.2.1", fmi.getString(Tag.TransferSyntaxUID),
                        "保存時と同じ転送構文（Explicit VR LE）で返る");
                assertEquals(pixels.get(i).length, ds.getBytes(Tag.PixelData).length);
                assertTrue(java.util.Arrays.equals(pixels.get(i), ds.getBytes(Tag.PixelData)), "画素が変わらない");
            }
        }

        ObjectProvider<WebDicomDataService> provider = Mockito.mock(ObjectProvider.class);
        Mockito.when(provider.getIfAvailable()).thenReturn(web);
        AnonymizeService svc = new AnonymizeService(Mockito.mock(DicomInstanceRepository.class),
                new AnonymizeMaskStore(), provider, new PixelCodec(props),
                new StorageLayout(Path.of("target", "no-storage-root")));
        AnonymizeJobService jobs = new AnonymizeJobService(svc, web, dir.resolve("jobs"), 2, 60_000);
        try {
            AnonymizeConfig cfg = new AnonymizeConfig();
            cfg.setRandomSeed(7L);
            String id = jobs.submit(List.of(study), cfg, false, Map.of()).jobId();
            AnonymizeJobService.Status st = null;
            for (int i = 0; i < 200; i++) {
                st = jobs.status(id);
                if (st.state() == AnonymizeJobService.State.DONE || st.state() == AnonymizeJobService.State.FAILED) {
                    break;
                }
                Thread.sleep(100);
            }
            assertEquals(AnonymizeJobService.State.DONE, st.state(), st.toString());
            int n = 0;
            try (ZipInputStream zin = new ZipInputStream(Files.newInputStream(jobs.zipOf(id)))) {
                ZipEntry e;
                while ((e = zin.getNextEntry()) != null) {
                    Attributes ds;
                    try (DicomInputStream in = new DicomInputStream(new ByteArrayInputStream(zin.readAllBytes()))) {
                        in.readFileMetaInformation();
                        ds = in.readDataset();
                    }
                    assertNotEquals("TEST^BURNED", ds.getString(Tag.PatientName), "氏名が置き換わっている");
                    assertEquals("YES", ds.getString(Tag.PatientIdentityRemoved));
                    assertFalse(java.util.List.of(sops).contains(ds.getString(Tag.SOPInstanceUID)), "UID が原本と違う");
                    assertNotEquals(study, ds.getString(Tag.StudyInstanceUID));
                    n++;
                }
            }
            assertEquals(3, n);
        } finally {
            jobs.shutdown();
        }
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.nifti.FloatNiftiFixture;

/**
 * NIfTI の float を Parametric Map で取り込んだシリーズ（fw/nifti-import.md §3.1・F4）にテクスチャを掛ける。
 * 前は画素を PixelData からしか読まず「スライスをデコードできません」で止まっていた。
 * NaN（値なし）を含むシリーズは、窓の中の NaN を RadiomicsJ がどう扱うか確かめていないので断る。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.profiles.active=standalone",
                "spring.datasource.url=jdbc:h2:mem:pmtex;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class ParametricMapTextureIntegrationTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @BeforeAll
    static void headless() {
        System.setProperty("java.awt.headless", "true");
    }

    @Autowired
    DicomStorageService storage;

    @Autowired
    TextureSeriesService textureService;

    private static final int N = 12;
    private static final int NZ = 4;
    private static final String STUDY = UIDUtils.createUID();

    /** 格子模様の小さい float（ADC のよう）。 */
    private static float value(int i, int j, int k) {
        return (float) (0.0007 + 0.0004 * (((i / 3) + (j / 3)) % 2) + 0.00001 * (i + j + k));
    }

    private String ingest(String series, FloatNiftiFixture.Value v) throws IOException {
        Path nii = FloatNiftiFixture.write(Files.createTempFile(tmp, "adc", ".nii"), N, N, NZ, 1.0, 1.0, 1.0, v);
        for (Attributes ds : FloatNiftiFixture.toParametricMap(nii, "PM^TEX", "PM^TEX", STUDY, series, "mm2/s")) {
            Path f = Files.createTempFile(tmp, "pm", ".dcm");
            try (DicomOutputStream out = new DicomOutputStream(f.toFile())) {
                out.writeDataset(ds.createFileMetaInformation(UID.ExplicitVRLittleEndian), ds);
            }
            storage.ingest(f);
        }
        return series;
    }

    private static TextureSeriesRequest request(String series) {
        return new TextureSeriesRequest(STUDY, series, null, 0, "GLCM_JointEntropy", 3, 1, false, 0, 0,
                Map.of("MASK_LABEL_INT", "1"), null, null, null);
    }

    @Test
    void floatParametricMapBuildsATextureMap() throws Exception {
        String series = ingest(UIDUtils.createUID(), ParametricMapTextureIntegrationTest::value);
        TextureSeriesService.Result r = textureService.create(request(series));
        assertEquals(NZ, r.sopInstanceUids().size());
        boolean nonZero = false;
        for (Path f : storage.resolveFiles(STUDY, List.of(r.seriesInstanceUid()))) {
            try (DicomInputStream in = new DicomInputStream(f.toFile())) {
                in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
                byte[] px = in.readDataset().getBytes(Tag.PixelData);
                for (byte b : px) {
                    nonZero |= b != 0;
                }
            }
        }
        assertTrue(nonZero, "格子模様なので結合エントロピーは 0 ではない");
    }

    @Test
    void refusesASeriesWithNaN() throws Exception {
        String series = ingest(UIDUtils.createUID(),
                (i, j, k) -> i == 2 && j == 2 && k == 1 ? Float.NaN : value(i, j, k));
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> textureService.create(request(series)));
        assertTrue(e.getMessage().contains("NaN"), e.getMessage());
    }
}

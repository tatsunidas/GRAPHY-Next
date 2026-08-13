/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * GLAM 可視化マップを、保管庫のシリーズから派生シリーズが出来上がるところまで通しで確かめる。
 *
 * <p>単体テストが見ていない配管を押さえるためのもの。具体的には、ターゲットとマスクを IPP で
 * 揃えられること、{@code pixelDepth} がスライス間隔から入ること、GLAM の前提チェックが
 * エンジンの中で効くこと、そして出来上がった DICOM が<b>元シリーズと同じ幾何</b>を持ち、
 * 値の意味を決めたパラメータを自分自身に書き残していること。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                // Radiomics は画素をローカル保管庫から直接読むため standalone 専用（RadiomicsMode）。
                // このテストが検証しているのはまさにその経路なので、同じモードで動かす。
                // 付ける前は既定（web 相当）で走っており、モードの前提を確かめないまま通っていた。
                "spring.profiles.active=standalone",
                "spring.datasource.url=jdbc:h2:mem:glamtex;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class GlamTextureSeriesIntegrationTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DicomStorageService storage;

    @Autowired
    TextureSeriesService textureService;

    @Autowired
    GlamAnalysisService analysisService;

    private static final int COLS = 24;
    private static final int ROWS = 24;
    private static final int SLICES = 10;
    private static final double PIXEL_SPACING = 1.0;
    private static final double SLICE_SPACING = 1.0;

    private static final String STUDY_UID = UIDUtils.createUID();
    private static final String SOURCE_SERIES_UID = UIDUtils.createUID();
    private static final String MASK_SERIES_UID = UIDUtils.createUID();
    private static final String FRAME_OF_REFERENCE_UID = UIDUtils.createUID();

    @BeforeAll
    static void quietImageJ() {
        // ヘッドレスで動かす。GLAM は等方でないと IJ.log に書くため、AWT を掴ませない
        System.setProperty("java.awt.headless", "true");
    }

    /**
     * 濃度値を立方体に並べた 16bit のスライス。窓が構造を見られるようにしてある。
     * ImagePositionPatient を Z 方向へ等間隔に並べるので、スライス間隔もここから決まる。
     */
    private Attributes sourceSlice(int z) {
        Attributes a = new Attributes();
        a.setString(Tag.PatientID, VR.LO, "GLAM^TEST");
        a.setString(Tag.PatientName, VR.PN, "PHANTOM^GLAM");
        a.setString(Tag.StudyInstanceUID, VR.UI, STUDY_UID);
        a.setString(Tag.SeriesInstanceUID, VR.UI, SOURCE_SERIES_UID);
        a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        a.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        a.setString(Tag.Modality, VR.CS, "CT");
        a.setString(Tag.StudyDate, VR.DA, "20260101");
        a.setString(Tag.SeriesDescription, VR.LO, "GLAM source");
        a.setString(Tag.SeriesNumber, VR.IS, "1");
        a.setString(Tag.InstanceNumber, VR.IS, String.valueOf(z + 1));
        a.setString(Tag.FrameOfReferenceUID, VR.UI, FRAME_OF_REFERENCE_UID);
        a.setDouble(Tag.ImageOrientationPatient, VR.DS, 1, 0, 0, 0, 1, 0);
        a.setDouble(Tag.ImagePositionPatient, VR.DS, 0, 0, z * SLICE_SPACING);
        a.setDouble(Tag.PixelSpacing, VR.DS, PIXEL_SPACING, PIXEL_SPACING);
        a.setDouble(Tag.SliceThickness, VR.DS, SLICE_SPACING);

        a.setInt(Tag.Rows, VR.US, ROWS);
        a.setInt(Tag.Columns, VR.US, COLS);
        a.setInt(Tag.BitsAllocated, VR.US, 16);
        a.setInt(Tag.BitsStored, VR.US, 16);
        a.setInt(Tag.HighBit, VR.US, 15);
        a.setInt(Tag.SamplesPerPixel, VR.US, 1);
        a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        a.setInt(Tag.PixelRepresentation, VR.US, 0);
        a.setDouble(Tag.RescaleSlope, VR.DS, 1.0);
        a.setDouble(Tag.RescaleIntercept, VR.DS, 0.0);

        byte[] px = new byte[ROWS * COLS * 2];
        for (int y = 0; y < ROWS; y++) {
            for (int x = 0; x < COLS; x++) {
                int block = (x / 3) + (y / 3) + (z / 3);
                int value = (block % 4) * 100;
                int i = (y * COLS + x) * 2;
                px[i] = (byte) (value & 0xFF);
                px[i + 1] = (byte) ((value >> 8) & 0xFF);
            }
        }
        a.setBytes(Tag.PixelData, VR.OW, px);
        return a;
    }

    /** ターゲットと同じ幾何の、中央を覆う箱マスク。 */
    private Attributes maskSlice(int z) {
        Attributes a = sourceSlice(z);
        a.setString(Tag.SeriesInstanceUID, VR.UI, MASK_SERIES_UID);
        a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        a.setString(Tag.SeriesDescription, VR.LO, "GLAM mask");
        a.setString(Tag.SeriesNumber, VR.IS, "2");

        byte[] px = new byte[ROWS * COLS * 2];
        boolean inZ = z >= 2 && z < SLICES - 2;
        for (int y = 0; y < ROWS; y++) {
            for (int x = 0; x < COLS; x++) {
                boolean inside = inZ && x >= 6 && x < 18 && y >= 6 && y < 18;
                int i = (y * COLS + x) * 2;
                px[i] = (byte) (inside ? 1 : 0);
                px[i + 1] = 0;
            }
        }
        a.setBytes(Tag.PixelData, VR.OW, px);
        return a;
    }

    private void ingest(Attributes dataset) throws IOException {
        Path file = Files.createTempFile(tmp, "phantom", ".dcm");
        Attributes fmi = dataset.createFileMetaInformation(UID.ExplicitVRLittleEndian);
        try (DicomOutputStream out = new DicomOutputStream(file.toFile())) {
            out.writeDataset(fmi, dataset);
        }
        storage.ingest(file);
    }

    /**
     * ファントムは 1 度だけ投入する。
     *
     * <p>Spring のコンテキストはテスト間で使い回されるため、テストごとに投入すると同じ Z に
     * 別 SOP のスライスが積み上がる。{@code SeriesLayout} はそれを C 次元として展開するので、
     * マスクが 2 チャンネル・3 チャンネルと増えていき、chan 0 がたまたま正しいことに寄りかかった
     * テストになってしまう。
     */
    private static boolean phantomIngested;

    private synchronized void ingestPhantom() throws IOException {
        if (phantomIngested) {
            return;
        }
        for (int z = 0; z < SLICES; z++) {
            ingest(sourceSlice(z));
            ingest(maskSlice(z));
        }
        phantomIngested = true;
    }

    private static Map<String, String> settings() {
        Map<String, String> s = new HashMap<>();
        s.put("MASK_LABEL_INT", "1");
        s.put("BINCOUNT_GLAM_BOOL", "true");
        s.put("BINCOUNT_GLAM_INT", "8");
        return s;
    }

    private static TextureSeriesRequest request(String feature, int kernel, int stride, boolean force2D,
                                                String maskSeriesUid) {
        return new TextureSeriesRequest(STUDY_UID, SOURCE_SERIES_UID, maskSeriesUid, 0, feature, kernel, stride,
                force2D, 0, 0, settings(), null, null, null);
    }

    @Test
    void buildsAGlamMapSeriesThatSharesTheGeometryOfItsSource() throws Exception {
        ingestPhantom();

        TextureSeriesService.Result result = textureService.create(
                request("GLAM_SecondVirialCoefficient_Mean", 7, 3, false, MASK_SERIES_UID));

        assertNotNull(result);
        assertNotEquals(SOURCE_SERIES_UID, result.seriesInstanceUid());
        assertEquals(SLICES, result.sopInstanceUids().size(), "one instance per source slice");

        List<Path> files = storage.resolveFiles(STUDY_UID, List.of(result.seriesInstanceUid()));
        assertEquals(SLICES, files.size());

        Attributes first = null;
        for (Path file : files) {
            try (DicomInputStream in = new DicomInputStream(file.toFile())) {
                Attributes ds = in.readDataset();
                if (first == null || ds.getInt(Tag.InstanceNumber, 0) == 1) {
                    first = ds;
                }
            }
        }
        assertNotNull(first);

        // 幾何は元と共有していること（Fusion で重ねられる条件）
        assertEquals(FRAME_OF_REFERENCE_UID, first.getString(Tag.FrameOfReferenceUID));
        assertEquals(STUDY_UID, first.getString(Tag.StudyInstanceUID));
        assertArrayEqualsWithin(new double[]{1, 0, 0, 0, 1, 0}, first.getDoubles(Tag.ImageOrientationPatient));
        assertArrayEqualsWithin(new double[]{PIXEL_SPACING, PIXEL_SPACING}, first.getDoubles(Tag.PixelSpacing));
        assertEquals(ROWS, first.getInt(Tag.Rows, 0));
        assertEquals(COLS, first.getInt(Tag.Columns, 0));

        // 32bit の原値は Rescale で戻せる形で入っていること
        assertEquals(16, first.getInt(Tag.BitsAllocated, 0));
        assertEquals(0, first.getInt(Tag.PixelRepresentation, -1));
        assertTrue(first.getDouble(Tag.RescaleSlope, 0) > 0);
        assertEquals("GLAM_SecondVirialCoefficient_Mean", first.getString(Tag.RescaleType));

        // 値の意味を決めたパラメータをシリーズ自身が持っていること
        String derivation = first.getString(Tag.DerivationDescription);
        assertNotNull(derivation);
        assertTrue(derivation.contains("maxRadius=3"), derivation);
        assertTrue(derivation.contains("boundaryCorrection="), derivation);
        assertTrue(derivation.contains("margin="), derivation);

        // マップに実際の値が乗っていること（全面ゼロで「成功」しないこと）
        assertTrue(hasNonZeroPixels(files), "the map should carry values inside the roi");

        /*
         * 値の全域が見える窓が入っていること。特徴値の範囲はモダリティ由来の W/L とは無関係で、
         * 何も書かないとビューアは既定の窓で開き、マップは一様な白に潰れて何も読めない
         * （実機検証で実際にそうなった）。
         */
        double windowWidth = first.getDouble(Tag.WindowWidth, 0);
        double windowCenter = first.getDouble(Tag.WindowCenter, Double.NaN);
        double slope = first.getDouble(Tag.RescaleSlope, 0);
        double intercept = first.getDouble(Tag.RescaleIntercept, 0);
        assertTrue(windowWidth > 0, "expected a window width, got " + windowWidth);
        assertEquals(slope * 65535.0, windowWidth, Math.abs(windowWidth) * 1e-6,
                "the window should span the whole range the pixels were scaled into");
        assertEquals(intercept + windowWidth / 2.0, windowCenter,
                Math.abs(windowCenter) * 1e-6 + 1e-9, "the window should be centred on that range");
    }

    @Test
    void refusesGlamInTwoDimensionsRatherThanReturningAnEmptyMap() throws Exception {
        ingestPhantom();
        // 2D で頼まれると RadiomicsJ は窓ごとに例外を投げ、マップ側がそれを 0 で握り潰す。
        // 黙って全面ゼロのシリーズを作るくらいなら断る。
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> textureService.create(request("GLAM_PotentialEnergy_Mean", 7, 3, true, MASK_SERIES_UID)));
        assertTrue(e.getMessage().contains("3D"), e.getMessage());
    }

    @Test
    void refusesGlamWithoutAMask() throws Exception {
        ingestPhantom();
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> textureService.create(request("GLAM_PotentialEnergy_Mean", 7, 3, false, null)));
        assertTrue(e.getMessage().contains("マスク"), e.getMessage());
    }

    @Test
    void otherFamiliesStillBuildAMapThroughTheSamePath() throws Exception {
        ingestPhantom();
        TextureSeriesService.Result result = textureService.create(
                request("GLCM_JointEntropy", 7, 3, false, MASK_SERIES_UID));
        assertEquals(SLICES, result.sopInstanceUids().size());
        assertTrue(hasNonZeroPixels(storage.resolveFiles(STUDY_UID, List.of(result.seriesInstanceUid()))));
    }

    private static boolean hasNonZeroPixels(List<Path> files) throws IOException {
        for (Path file : files) {
            try (DicomInputStream in = new DicomInputStream(file.toFile())) {
                in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
                Attributes ds = in.readDataset();
                byte[] px = ds.getBytes(Tag.PixelData);
                if (px == null) continue;
                for (byte b : px) {
                    if (b != 0) return true;
                }
            }
        }
        return false;
    }

    private static void assertArrayEqualsWithin(double[] expected, double[] actual) {
        assertNotNull(actual);
        assertEquals(expected.length, actual.length);
        for (int i = 0; i < expected.length; i++) {
            assertEquals(expected[i], actual[i], 1e-6, "index " + i);
        }
    }

    // ── GLAM 解析（ROI 全体・記述子そのもの） ────────────────────

    private static GlamAnalysisRequest analysisRequest(String maskSeriesUid, Integer maxRadius) {
        return new GlamAnalysisRequest(STUDY_UID, SOURCE_SERIES_UID, maskSeriesUid, 0, 0, 0, maxRadius, settings());
    }

    @Test
    void analysesTheWholeRoiAndReturnsTheDescriptorsThemselves() throws Exception {
        ingestPhantom();
        GlamAnalysis a = analysisService.analyze(analysisRequest(MASK_SERIES_UID, 6));

        assertEquals(8, a.nBins(), "the request asked for 8 bins");
        assertEquals(6, a.maxRadius());
        assertEquals(6, a.radii().length);
        assertEquals(1, a.radii()[0], "r starts at 1");

        // 19 行列すべてが返ること（UI がどれを選んでも描けること）
        assertEquals(19, a.matrices().size());
        assertTrue(a.matrices().containsKey("SecondVirialCoefficient"));
        assertTrue(a.diagonalOnly().contains("Compressibility"), "Compressibility is self pairs only");

        // 自己親和性は [bin][r]
        assertEquals(a.nBins(), a.selfAffinity().length);
        assertEquals(a.maxRadius(), a.selfAffinity()[0].length);

        // ビン占有数の合計 = ROI ボクセル数。ここがずれると曲線の読み方の前提が崩れる
        long occupied = 0;
        for (long n : a.binOccupancy()) occupied += n;
        assertEquals(a.roiVoxelCount(), occupied, "every roi voxel lands in exactly one bin");
        assertEquals(12 * 12 * (SLICES - 4), a.roiVoxelCount(), "the box mask");
    }

    @Test
    void theRandomReferenceStateSitsExactlyAtTheChanceLevel() throws Exception {
        /*
         * 境界補正が入っていると、ランダム参照状態は距離によらず 1.0 に正規化される
         * （RadiomicsJ の GLAM 解説 3.6 / 5.2）。実装が ROI の形の影響を正しく割り戻せているかは、
         * ここを見るのが一番はっきりする。観測側の曲線と違い、期待値が理屈で決まっているため。
         */
        ingestPhantom();
        GlamAnalysis a = analysisService.analyze(analysisRequest(MASK_SERIES_UID, 6));

        int checked = 0;
        for (int bin = 0; bin < a.nBins(); bin++) {
            if (a.binOccupancy()[bin] == 0) continue; // 空のビンは曲線が定義されない
            for (double v : a.selfAffinityRandom()[bin]) {
                if (!Double.isFinite(v) || v == 0d) continue;
                assertEquals(1.0, v, 0.05, "randomised reference should sit at chance, bin " + bin);
                checked++;
            }
        }
        assertTrue(checked > 0, "expected at least one defined random curve");
    }

    @Test
    void refusesAnalysisWithoutAMask() throws Exception {
        ingestPhantom();
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> analysisService.analyze(analysisRequest(null, 6)));
        assertTrue(e.getMessage().contains("マスク"), e.getMessage());
    }

    @Test
    void looksFurtherThanAMapCanSee() throws Exception {
        /*
         * これがこの機能の存在理由。可視化マップはカーネル半径で頭打ちになり、kernel 7 なら
         * maxRadius は 3 までしか取れない。解析はカーネルが無いのでそれより遠くまで見られる。
         */
        ingestPhantom();
        int mapCap = GlamMapSupport.maxRadiusFor(7, settings());
        GlamAnalysis a = analysisService.analyze(analysisRequest(MASK_SERIES_UID, 8));
        assertEquals(3, mapCap, "a kernel of 7 caps the map at r=3");
        assertTrue(a.maxRadius() > mapCap, "the analysis is not bound by a kernel");
    }
}

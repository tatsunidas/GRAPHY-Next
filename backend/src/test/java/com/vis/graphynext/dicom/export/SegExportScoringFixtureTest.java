/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.export;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 採点スクリプト（automator/tools/monai_score.py）の固定データを、本体の実際の SEG 書き出しで作る。
 *
 * <p>採点側と同じ仮定で手書きした SEG では、読み方の誤りが相殺されて見えなくなる。だから書き出しは
 * {@link SegExportService} 本物に任せ、「正しい答え」はこのテストの中に配列で明示する（非対称・非等方間隔・
 * 斜めの向き・3 ラベル）。各ラベルのボクセル中心の患者座標（LPS・mm）は DICOM の式
 * {@code IPP + 列番号 × 列間隔 × IOP[0..2] + 行番号 × 行間隔 × IOP[3..5]} で、読み取り側とは別に計算する。
 *
 * <p>通常のテスト実行では何も書かない。作り直すとき:
 * {@code mvn -q -Dfrontend.skip=true test -Dtest=SegExportScoringFixtureTest -Dseg.fixture.out=<dir>}
 */
class SegExportScoringFixtureTest {

    @TempDir
    Path dir;

    private static final int ROWS = 5;
    private static final int COLS = 6;
    private static final int SLICES = 4;
    // 行方向 = +x、列方向 = -y（IOP の列ベクトルが -y）→ スライスの法線は -z
    private static final double[] IOP = {1, 0, 0, 0, -1, 0};
    private static final double[] SPACING = {0.8, 1.5}; // [行間隔, 列間隔]
    private static final double STEP = 3.0;             // スライス間隔（-z 方向に進む）
    private static final double[] ORIGIN = {-10.0, 20.0, 30.0};

    /** lab[スライス][行][列]。1 = 左上の塊、2 = 右下の塊（2 スライスにまたがる）、3 = 1 ボクセルだけ。 */
    private static int[][][] labels() {
        int[][][] lab = new int[SLICES][ROWS][COLS];
        lab[0][0][0] = 1; lab[0][0][1] = 1; lab[0][1][0] = 1;
        lab[1][0][0] = 1;
        lab[1][3][4] = 2; lab[1][3][5] = 2; lab[1][4][5] = 2;
        lab[2][3][5] = 2; lab[2][4][5] = 2; lab[2][4][4] = 2;
        lab[3][2][3] = 3;
        return lab;
    }

    private static double[] centre(int z, int r, int c) {
        double[] p = new double[3];
        for (int k = 0; k < 3; k++) {
            p[k] = ORIGIN[k] - z * STEP * (k == 2 ? 1 : 0) + c * SPACING[1] * IOP[k] + r * SPACING[0] * IOP[3 + k];
        }
        return p;
    }

    private static String planeData(int[][] plane) {
        byte[] b = new byte[ROWS * COLS];
        for (int r = 0; r < ROWS; r++) {
            for (int c = 0; c < COLS; c++) {
                b[r * COLS + c] = (byte) plane[r][c];
            }
        }
        return Base64.getEncoder().encodeToString(b);
    }

    @Test
    void writesFixtureWhenAsked() throws Exception {
        int[][][] lab = labels();
        List<SegExportRequest.Plane> planes = new ArrayList<>();
        for (int z = 0; z < SLICES; z++) {
            double[] ipp = centre(z, 0, 0);
            planes.add(new SegExportRequest.Plane("1.2.3.4." + (z + 1), ipp, planeData(lab[z])));
        }
        SegExportRequest.LabelPlanes lp = new SegExportRequest.LabelPlanes(1,
                List.of(new SegExportRequest.Label(1, "left_thing", null, null),
                        new SegExportRequest.Label(2, "right_thing", null, null),
                        new SegExportRequest.Label(3, "dot", null, null)),
                planes);
        SegExportRequest req = new SegExportRequest("1.2.3", "1.2.3.4", ROWS, COLS, IOP, SPACING, STEP,
                "1.2.3.5", "scoring fixture", List.of(), null, lp);

        Path header = dir.resolve("src.dcm");
        Attributes src = new Attributes();
        src.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        src.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.9");
        src.setString(Tag.PatientID, VR.LO, "P");
        src.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        try (DicomOutputStream out = new DicomOutputStream(header.toFile())) {
            out.writeDataset(src.createFileMetaInformation(UID.ExplicitVRLittleEndian), src);
        }
        DicomStorageService storage = mock(DicomStorageService.class);
        when(storage.resolveFiles(anyString(), anyList())).thenReturn(List.of(header));
        Path stored = dir.resolve("seg.dcm");
        doAnswer(inv -> {
            Files.copy((Path) inv.getArgument(0), stored);
            return null;
        }).when(storage).ingest(any(Path.class));
        @SuppressWarnings("unchecked")
        ObjectProvider<WebDicomDataService> web = mock(ObjectProvider.class);
        new SegExportService(storage, web).export(req);
        assertEquals(true, Files.size(stored) > 0);

        String out = System.getProperty("seg.fixture.out");
        if (out == null || out.isBlank()) {
            return;
        }
        Path outDir = Path.of(out);
        Files.createDirectories(outDir);
        Files.copy(stored, outDir.resolve("seg_fixture.dcm"), java.nio.file.StandardCopyOption.REPLACE_EXISTING);

        String[] names = {null, "left_thing", "right_thing", "dot"};
        StringBuilder json = new StringBuilder("{\n  \"voxel_ml\": ");
        json.append(String.format(Locale.ROOT, "%.9f", SPACING[0] * SPACING[1] * STEP / 1000.0)).append(",\n  \"labels\": {\n");
        for (int v = 1; v <= 3; v++) {
            List<String> pts = new ArrayList<>();
            for (int z = 0; z < SLICES; z++) {
                for (int r = 0; r < ROWS; r++) {
                    for (int c = 0; c < COLS; c++) {
                        if (lab[z][r][c] == v) {
                            double[] p = centre(z, r, c);
                            pts.add(String.format(Locale.ROOT, "[%.6f, %.6f, %.6f]", p[0], p[1], p[2]));
                        }
                    }
                }
            }
            json.append("    \"").append(v).append("\": {\"name\": \"").append(names[v]).append("\", \"points_lps\": [")
                    .append(String.join(", ", pts)).append("]}").append(v < 3 ? ",\n" : "\n");
        }
        json.append("  }\n}\n");
        Files.writeString(outDir.resolve("expected.json"), json.toString(), StandardCharsets.UTF_8);
    }
}

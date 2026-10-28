/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.vis.graphynext.dicom.export.SegExportRequest;
import com.vis.graphynext.dicom.export.SegExportService;
import com.vis.graphynext.dicom.export.SegReadService;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class SegSourceResolverTest {

    @TempDir
    Path dir;

    private static final String STUDY = "1.2.3";

    private static SegSourceResolver.SeriesInfo info(String uid, String modality) {
        return new SegSourceResolver.SeriesInfo(uid, modality);
    }

    /** 組み立て済みの引数で作る。ヘッダは SEG ごとに差し替える。 */
    private static SegSourceResolver resolver(List<SegSourceResolver.SeriesInfo> series,
                                              Map<String, SegSourceResolver.SegHeader> headers,
                                              Map<String, List<SegSourceResolver.SegmentInfo>> segments,
                                              Map<String, String> frameOfReference) {
        return new SegSourceResolver(s -> series, (st, se) -> headers.get(se), (st, se) -> segments.getOrDefault(se, List.of()),
                (st, se) -> frameOfReference.get(se));
    }

    private static List<SegSourceResolver.SegmentInfo> segs(int... numbers) {
        return java.util.Arrays.stream(numbers).mapToObj(n -> new SegSourceResolver.SegmentInfo(n, "s" + n)).toList();
    }

    @Test
    void referencedSeriesGivesAuto_andMaskChannelIsTheRankNotTheNumber() {
        SegSourceResolver r = resolver(
                List.of(info("CT", "CT"), info("SEG1", "SEG")),
                Map.of("SEG1", new SegSourceResolver.SegHeader(List.of("CT"), "F")),
                Map.of("SEG1", segs(1, 3, 5)), Map.of());
        List<BatchPair> pairs = r.resolve(List.of(STUDY));

        assertEquals(3, pairs.size());
        for (BatchPair p : pairs) {
            assertEquals(BatchPair.Status.AUTO, p.status());
            assertEquals("CT", p.sourceSeriesUid());
            assertEquals("SEG1", p.maskSeriesUid());
        }
        assertEquals(List.of(1, 3, 5), pairs.stream().map(BatchPair::segmentNumber).toList());
        assertEquals(List.of(0, 1, 2), pairs.stream().map(BatchPair::maskChannel).toList(),
                "番号 1,3,5 のセグメントのチャンネルは 0,1,2");
    }

    @Test
    void noReferenceWithOneSameFrameCandidateIsStillNotConfirmed() {
        SegSourceResolver r = resolver(
                List.of(info("CT", "CT"), info("MR", "MR"), info("SEG1", "SEG")),
                Map.of("SEG1", new SegSourceResolver.SegHeader(List.of(), "F1")),
                Map.of("SEG1", segs(1)), Map.of("CT", "F1", "MR", "F2"));
        BatchPair p = r.resolve(List.of(STUDY)).get(0);

        assertEquals(BatchPair.Status.NEEDS_CONFIRMATION, p.status(), "候補が 1 つでも自動では確定しない");
        assertNull(p.sourceSeriesUid());
        assertEquals(List.of("CT"), p.sourceCandidates());
    }

    @Test
    void noCandidateAtAllIsExcluded() {
        SegSourceResolver r = resolver(
                List.of(info("CT", "CT"), info("SEG1", "SEG")),
                Map.of("SEG1", new SegSourceResolver.SegHeader(List.of("GONE"), "F1")),
                Map.of("SEG1", segs(1)), Map.of("CT", "F2"));
        BatchPair p = r.resolve(List.of(STUDY)).get(0);

        assertEquals(BatchPair.Status.EXCLUDED, p.status());
        assertTrue(p.reason().contains("元画像"), p.reason());
    }

    @Test
    void segWithoutForegroundSegmentsIsExcludedAndReported() {
        SegSourceResolver r = resolver(
                List.of(info("CT", "CT"), info("SEG1", "SEG")),
                Map.of("SEG1", new SegSourceResolver.SegHeader(List.of("CT"), "F")),
                Map.of("SEG1", List.of()), Map.of());
        List<BatchPair> pairs = r.resolve(List.of(STUDY));

        assertEquals(1, pairs.size(), "黙って落とさず、理由つきで 1 件返す");
        assertEquals(BatchPair.Status.EXCLUDED, pairs.get(0).status());
        assertTrue(pairs.get(0).reason().contains("マスクが空"), pairs.get(0).reason());
    }

    @Test
    void unreadableSegIsExcludedWithTheException_andOtherSegsContinue() {
        SegSourceResolver r = new SegSourceResolver(
                s -> List.of(info("CT", "CT"), info("BAD", "SEG"), info("OK", "SEG")),
                (st, se) -> {
                    if ("BAD".equals(se)) {
                        throw new IOException("disk gone");
                    }
                    return new SegSourceResolver.SegHeader(List.of("CT"), "F");
                },
                (st, se) -> segs(1), (st, se) -> null);
        List<BatchPair> pairs = r.resolve(List.of(STUDY));

        assertEquals(2, pairs.size());
        assertEquals(BatchPair.Status.EXCLUDED, pairs.get(0).status());
        assertTrue(pairs.get(0).reason().contains("IOException"), pairs.get(0).reason());
        assertEquals(BatchPair.Status.AUTO, pairs.get(1).status());
    }

    @Test
    void nonImageSeriesAreNeverSourceCandidates() {
        SegSourceResolver r = resolver(
                List.of(info("RT", "RTSTRUCT"), info("SR1", "SR"), info("SEG1", "SEG")),
                Map.of("SEG1", new SegSourceResolver.SegHeader(List.of("RT"), "F")),
                Map.of("SEG1", segs(1)), Map.of("RT", "F", "SR1", "F"));
        BatchPair p = r.resolve(List.of(STUDY)).get(0);

        assertEquals(BatchPair.Status.EXCLUDED, p.status(), "RTSTRUCT・SR は元画像にしない");
    }

    /** SegExportService が実際に書いた SEG から、参照元とセグメントの添字が引けること（モックではない実物）。 */
    @Test
    void worksOnASegWrittenByTheRealExporter() throws Exception {
        Attributes src = new Attributes();
        src.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        src.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.9");
        src.setString(Tag.PatientID, VR.LO, "P");
        src.setString(Tag.StudyInstanceUID, VR.UI, STUDY);
        Path header = dir.resolve("src.dcm");
        try (DicomOutputStream out = new DicomOutputStream(header.toFile())) {
            out.writeDataset(src.createFileMetaInformation(UID.ExplicitVRLittleEndian), src);
        }
        DicomStorageService exportStorage = mock(DicomStorageService.class);
        when(exportStorage.resolveFiles(anyString(), anyList())).thenReturn(List.of(header));
        Path stored = dir.resolve("seg.dcm");
        doAnswer(inv -> {
            Files.copy((Path) inv.getArgument(0), stored);
            return null;
        }).when(exportStorage).ingest(any(Path.class));
        @SuppressWarnings("unchecked")
        ObjectProvider<WebDicomDataService> noWeb = mock(ObjectProvider.class);
        // ラベル 7 だけが前景を持つ平面と、ラベル 1・3 の平面（9 は前景なしで落ちる）
        SegExportRequest.LabelPlanes lp = new SegExportRequest.LabelPlanes(1,
                List.of(new SegExportRequest.Label(1, "a", null, null), new SegExportRequest.Label(7, "b", null, null),
                        new SegExportRequest.Label(9, "absent", null, null)),
                List.of(new SegExportRequest.Plane("1.2.3.9", new double[]{0, 0, 0}, plane(1, 0, 7, 0, 0, 0))));
        new SegExportService(exportStorage, noWeb).export(new SegExportRequest(STUDY, "1.2.3.4", 2, 3,
                new double[]{1, 0, 0, 0, 1, 0}, new double[]{0.5, 0.5}, 2.0, null, "labels", List.of(), null, lp));

        // 読み取り側は、書き出された SEG の入ったストレージを見る
        DicomStorageService storage = mock(DicomStorageService.class);
        when(storage.resolveFiles(anyString(), anyList())).thenReturn(List.of(stored));
        DicomInstanceRepository repo = mock(DicomInstanceRepository.class);
        DicomInstanceRepository.SeriesSummary ct = mock(DicomInstanceRepository.SeriesSummary.class);
        when(ct.getSeriesInstanceUid()).thenReturn("1.2.3.4");
        when(ct.getModality()).thenReturn("CT");
        DicomInstanceRepository.SeriesSummary seg = mock(DicomInstanceRepository.SeriesSummary.class);
        when(seg.getSeriesInstanceUid()).thenReturn("1.2.3.77");
        when(seg.getModality()).thenReturn("SEG");
        when(repo.findSeriesSummaries(STUDY)).thenReturn(List.of(ct, seg));
        SegReadService reader = new SegReadService(storage, noWeb);

        List<BatchPair> pairs = new SegSourceResolver(repo, reader, storage).resolve(List.of(STUDY));

        try (DicomInputStream in = new DicomInputStream(stored.toFile())) {
            assertTrue(in.readDataset().contains(Tag.ReferencedSeriesSequence), "書き出した SEG に参照元がある");
        }
        assertTrue(pairs.size() >= 1, pairs.toString());
        for (int i = 0; i < pairs.size(); i++) {
            BatchPair p = pairs.get(i);
            assertEquals(BatchPair.Status.AUTO, p.status(), p.toString());
            assertEquals("1.2.3.4", p.sourceSeriesUid());
            assertEquals(i, p.maskChannel(), "前景のあるセグメントの昇順の添字");
        }
    }

    private static String plane(int... values) {
        byte[] b = new byte[values.length];
        for (int i = 0; i < values.length; i++) {
            b[i] = (byte) values[i];
        }
        return Base64.getEncoder().encodeToString(b);
    }
}

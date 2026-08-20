/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.Mockito;
import org.springframework.beans.factory.ObjectProvider;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ZIP を流し始める前の見積り（{@link AnonymizeService#preflight}）の単体テスト。
 *
 * <p>背景: ZIP はストリーミングで返すため、書き出しが 1 件も成功しなくても
 * **HTTP 200 ＋ 22 バイトの「正常だが空」の ZIP** が返り、UI は成功メッセージを出していた
 * （利用者からは「ZIP が空だった」としか見えず、原因も分からない）。
 * controller はこの見積りで 0 件を検出して 409 に落とす。
 */
class AnonymizePreflightTest {

    @SuppressWarnings("unchecked")
    private static AnonymizeService serviceWith(DicomInstanceRepository repo) {
        ObjectProvider<com.vis.graphynext.dicom.web.WebDicomDataService> web =
                Mockito.mock(ObjectProvider.class);
        Mockito.when(web.getIfAvailable()).thenReturn(null); // standalone
        return new AnonymizeService(repo, new AnonymizeMaskStore(), web);
    }

    private static DicomInstance instance(String sop, String uri) {
        DicomInstance i = new DicomInstance(sop);
        i.setUri(uri);
        return i;
    }

    @Test
    void resolvable_countsOnlyInstancesWhoseFileExists(@TempDir Path dir) throws IOException {
        Path present = dir.resolve("a.dcm");
        Files.writeString(present, "x");

        DicomInstanceRepository repo = Mockito.mock(DicomInstanceRepository.class);
        Mockito.when(repo.findByStudyInstanceUid("S1")).thenReturn(List.of(
                instance("1.1", present.toUri().toString()),
                instance("1.2", dir.resolve("missing.dcm").toUri().toString())));

        AnonymizeService.Preflight pre = serviceWith(repo).preflight(List.of("S1"));

        assertEquals(2, pre.indexed(), "索引上は 2 件");
        assertEquals(1, pre.resolvable(), "実体があるのは 1 件だけ");
        assertEquals(1, pre.problems().size());
        assertTrue(pre.problems().get(0).contains("1.2"), "欠けている SOP を名指しする: " + pre.problems());
    }

    @Test
    void resolvable_isZero_whenEveryFileIsGone(@TempDir Path dir) {
        DicomInstanceRepository repo = Mockito.mock(DicomInstanceRepository.class);
        Mockito.when(repo.findByStudyInstanceUid("S1")).thenReturn(List.of(
                instance("1.1", dir.resolve("gone1.dcm").toUri().toString()),
                instance("1.2", dir.resolve("gone2.dcm").toUri().toString())));

        AnonymizeService.Preflight pre = serviceWith(repo).preflight(List.of("S1"));

        // ここが 0 のとき controller は 409 を返す（空 ZIP を成功として返さない）。
        assertEquals(0, pre.resolvable());
        assertEquals(2, pre.indexed());
        assertEquals(2, pre.problems().size());
    }

    @Test
    void emptyStudy_isReportedAsProblem() {
        DicomInstanceRepository repo = Mockito.mock(DicomInstanceRepository.class);
        Mockito.when(repo.findByStudyInstanceUid("S-empty")).thenReturn(List.of());

        AnonymizeService.Preflight pre = serviceWith(repo).preflight(List.of("S-empty"));

        assertEquals(0, pre.indexed());
        assertEquals(0, pre.resolvable());
        assertTrue(pre.problems().get(0).contains("S-empty"), pre.problems().toString());
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import com.vis.graphynext.dicom.DicomLocalAeService;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import com.vis.graphynext.settings.SettingsService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 終了前の「いま走っている処理」（ActiveWork）: QR の取得（C-MOVE）。中止の口が無いので件数だけ出す。 */
class QrRetrieveActiveWorkTest {

    @Test
    @SuppressWarnings("unchecked")
    void 取得中を数え_cancelAllは何もせず_終わったら数えない() throws Exception {
        DimseQrService qr = mock(DimseQrService.class);
        CountDownLatch moving = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        when(qr.moveStudy(anyString(), anyInt(), any(), anyString(), any(), anyBoolean())).thenAnswer(inv -> {
            moving.countDown();
            release.await(10, TimeUnit.SECONDS);
            return 0;
        });
        ObjectProvider<WebDicomDataService> web = mock(ObjectProvider.class);
        when(web.getIfAvailable()).thenReturn(null);
        QrRetrieveService svc = new QrRetrieveService(qr, mock(DicomStorageService.class),
                mock(DicomLocalAeService.class), mock(SettingsService.class), web);
        assertEquals("qrRetrieve", svc.kind());
        assertFalse(svc.cancellable());
        assertEquals(0, svc.activeCount(), "何も無いとき");

        String id = svc.start("127.0.0.1", 104, "PACS", "1.2.3", null, 1, false);
        assertTrue(moving.await(5, TimeUnit.SECONDS));
        assertEquals(1, svc.activeCount());

        svc.cancelAll();

        assertEquals(1, svc.activeCount(), "中止の口が無いので、cancelAll を呼んでも状態は変わらない");
        assertFalse(svc.status(id).done());

        release.countDown();
        for (int i = 0; i < 250 && !svc.status(id).done(); i++) {
            Thread.sleep(20);
        }
        assertTrue(svc.status(id).done(), "終わる");
        assertEquals(0, svc.activeCount());
    }
}

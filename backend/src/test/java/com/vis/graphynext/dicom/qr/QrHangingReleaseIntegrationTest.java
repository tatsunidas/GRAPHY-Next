/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 解放（A-RELEASE）に応答しない相手（実例: 応答は返すのに解放を無視する中継サーバー）に、実物の findscu を向ける。
 * 以前は、検索が返らなかった（出力の EOF を待つ作りで、時間切れも効かなかった）。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:qrhangrelease;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false",
                "graphy.dicom.local-ae-title=GRAPHYNEXT"
        })
class QrHangingReleaseIntegrationTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DimseQrService qr;

    @BeforeAll
    static void check(@Autowired Dcm4cheTools t) {
        assumeTrue(t.isAvailable("findscu"), "dcm4che ツール未検出のためスキップ");
    }

    @Test
    void peerThatNeverAnswersRelease_stillReturnsTheResult_withinSeconds() throws Exception {
        try (HangingReleasePeer peer = new HangingReleasePeer("HANGREL", true)) {
            long t0 = System.nanoTime();
            var studies = qr.findStudiesForQr("127.0.0.1", peer.port, "HANGREL", Map.of(), false, FindProfile.DEFAULT);
            long ms = (System.nanoTime() - t0) / 1_000_000;
            assertEquals(0, studies.size(), "該当なし（status 0000H）は 0 件の成功");
            assertEquals(1, peer.findResponses.get(), "応答は 1 回");
            assertEquals(1, peer.releaseRequests.get(), "解放の要求は届いたが、相手は答えなかった");
            assertEquals(1, peer.aborts.get(), "--release-timeout で A-ABORT して終わった");
            assertTrue(ms < 20_000, "解放待ちで長く止まった: " + ms + " ms");
        }
    }
}

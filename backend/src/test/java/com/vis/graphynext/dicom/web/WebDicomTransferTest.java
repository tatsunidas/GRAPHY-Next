/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.web;

import com.sun.net.httpserver.HttpServer;
import com.vis.graphynext.dicom.DicomProperties;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * WADO-RS 一括取得（prefetch）・STOW-RS 保存の <b>multipart/related フレーミング</b>を、実 PACS 無しで検証する。
 * 送信（{@code buildMultipartRelated}）と受信（{@code allMultipartParts}/{@code firstMultipartPart}）の
 * 往復一致、及びインプロセス・スタブ DICOMweb サーバに対する prefetch→キャッシュ→retrieve→STOW の疎通を確認。
 */
class WebDicomTransferTest {

    /** 最小の Part-10 DICOM（FMI 付き）を作る。 */
    private static byte[] part10(String sopClassUid, String sopInstanceUid) throws IOException {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, sopClassUid);
        ds.setString(Tag.SOPInstanceUID, VR.UI, sopInstanceUid);
        ds.setString(Tag.PatientID, VR.LO, "PID1");
        Attributes fmi = ds.createFileMetaInformation(UID.ExplicitVRLittleEndian);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (DicomOutputStream dos = new DicomOutputStream(bos, UID.ExplicitVRLittleEndian)) {
            dos.writeDataset(fmi, ds);
        }
        return bos.toByteArray();
    }

    @Test
    void multipart_buildParse_roundTrip() {
        byte[] a = "hello-dicom".getBytes(StandardCharsets.US_ASCII);
        byte[] b = new byte[1000];
        for (int i = 0; i < b.length; i++) {
            b[i] = (byte) (i % 251); // CRLF/境界文字を含みうるバイナリ本体
        }
        String bnd = "BND-abc123";

        byte[] built = WebDicomDataService.buildMultipartRelated(List.of(a, b), bnd, "application/dicom");
        List<byte[]> parts = WebDicomDataService.allMultipartParts(built, bnd);
        assertEquals(2, parts.size(), "2 パートに戻るはず");
        assertArrayEquals(a, parts.get(0));
        assertArrayEquals(b, parts.get(1));

        // firstMultipartPart は先頭パート。
        assertArrayEquals(a, WebDicomDataService.firstMultipartPart(built, bnd));
        // boundary がクオートされていても解ける。
        assertEquals(2, WebDicomDataService.allMultipartParts(built, "\"" + bnd + "\"").size());
        // boundary 無し（単一 DICOM 直返し）は body 1 個。
        assertEquals(1, WebDicomDataService.allMultipartParts(a, null).size());
        assertArrayEquals(a, WebDicomDataService.firstMultipartPart(a, null));
    }

    @Test
    void prefetch_thenRetrieveFromCache_andStow() throws Exception {
        byte[] p1 = part10(UID.CTImageStorage, "1.2.100");
        byte[] p2 = part10(UID.CTImageStorage, "1.2.101");
        String bnd = "SRV-xyz";
        byte[] seriesBody = WebDicomDataService.buildMultipartRelated(List.of(p1, p2), bnd, "application/dicom");

        AtomicReference<byte[]> stowBody = new AtomicReference<>();
        AtomicReference<String> stowContentType = new AtomicReference<>();

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/studies", ex -> {
            if ("POST".equals(ex.getRequestMethod())) {
                // STOW-RS: 送信ボディと Content-Type を捕捉。
                stowContentType.set(ex.getRequestHeaders().getFirst("Content-Type"));
                stowBody.set(ex.getRequestBody().readAllBytes());
                byte[] r = "[]".getBytes(StandardCharsets.UTF_8);
                ex.getResponseHeaders().add("Content-Type", "application/dicom+json");
                ex.sendResponseHeaders(200, r.length);
                try (var os = ex.getResponseBody()) {
                    os.write(r);
                }
            } else {
                // WADO-RS シリーズ一括取得（GET .../studies/{s}/series/{se}）。
                ex.getResponseHeaders().add("Content-Type",
                        "multipart/related; type=\"application/dicom\"; boundary=" + bnd);
                ex.sendResponseHeaders(200, seriesBody.length);
                try (var os = ex.getResponseBody()) {
                    os.write(seriesBody);
                }
            }
        });
        server.start();
        try {
            DicomProperties props = new DicomProperties();
            props.getDicomweb().setBaseUrl("http://127.0.0.1:" + server.getAddress().getPort());
            WebDicomDataService svc = new WebDicomDataService(props);

            // prefetch: 1 リクエストで 2 インスタンスをキャッシュ。
            int n = svc.prefetchSeries("1.2", "3.4");
            assertEquals(2, n, "2 インスタンスがキャッシュされる");

            // retrieveInstance はキャッシュから即返る（バイト一致）。
            assertArrayEquals(p1, svc.retrieveInstance("1.2", "3.4", "1.2.100"));
            assertArrayEquals(p2, svc.retrieveInstance("1.2", "3.4", "1.2.101"));

            // STOW-RS: 送信ボディが正しい multipart/related になっている。
            svc.storeInstances(List.of(p1));
            assertTrue(stowContentType.get() != null && stowContentType.get().startsWith("multipart/related"),
                    "STOW は multipart/related");
            String sentBoundary = stowContentType.get().replaceAll(".*boundary=", "").trim();
            List<byte[]> sent = WebDicomDataService.allMultipartParts(stowBody.get(), sentBoundary);
            assertEquals(1, sent.size(), "1 パート送信");
            assertArrayEquals(p1, sent.get(0), "送信 DICOM が元と一致");
        } finally {
            server.stop(0);
        }
    }
}

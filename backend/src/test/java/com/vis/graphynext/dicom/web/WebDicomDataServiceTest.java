/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.web;

import com.sun.net.httpserver.HttpServer;
import com.vis.graphynext.dicom.DicomProperties;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * WebDicomDataService（DICOMweb BFF）の QIDO-RS を、インプロセスのスタブ DICOMweb サーバで検証。
 * 実 PACS（dcm4chee 等）が無くても DICOM JSON のリクエスト整形と応答パースを確認できる。
 */
class WebDicomDataServiceTest {

    @Test
    void searchStudies_sendsQidoRequest_andParsesDicomJson() throws Exception {
        // 2 件の Study を返すスタブ（DICOM JSON 配列）
        String json = "["
                + "{\"0020000D\":{\"vr\":\"UI\",\"Value\":[\"1.2.3\"]},"
                + " \"00100020\":{\"vr\":\"LO\",\"Value\":[\"PID1\"]},"
                + " \"00100010\":{\"vr\":\"PN\",\"Value\":[{\"Alphabetic\":\"YAMADA^TARO\"}]}},"
                + "{\"0020000D\":{\"vr\":\"UI\",\"Value\":[\"1.2.4\"]},"
                + " \"00100020\":{\"vr\":\"LO\",\"Value\":[\"PID1\"]}}"
                + "]";

        AtomicReference<String> seenPathAndQuery = new AtomicReference<>();
        AtomicReference<String> seenAccept = new AtomicReference<>();

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/studies", ex -> {
            seenPathAndQuery.set(ex.getRequestURI().toString());
            seenAccept.set(ex.getRequestHeaders().getFirst("Accept"));
            byte[] b = json.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", "application/dicom+json");
            ex.sendResponseHeaders(200, b.length);
            try (var os = ex.getResponseBody()) {
                os.write(b);
            }
        });
        server.start();
        try {
            DicomProperties props = new DicomProperties();
            props.getDicomweb().setBaseUrl("http://127.0.0.1:" + server.getAddress().getPort());
            WebDicomDataService svc = new WebDicomDataService(props);

            List<Attributes> studies = svc.searchStudies(Map.of("PatientID", "PID1"));

            assertEquals(2, studies.size(), "2 件の Study が返るはず");
            assertEquals("1.2.3", studies.get(0).getString(Tag.StudyInstanceUID));
            assertEquals("PID1", studies.get(0).getString(Tag.PatientID));
            assertEquals("YAMADA^TARO", studies.get(0).getString(Tag.PatientName));
            assertEquals("1.2.4", studies.get(1).getString(Tag.StudyInstanceUID));

            // 正しい QIDO リクエストになっているか
            assertTrue(seenPathAndQuery.get().startsWith("/studies?"), "QIDO は /studies に投げる");
            assertTrue(seenPathAndQuery.get().contains("PatientID=PID1"), "検索キーがクエリに乗る");
            assertEquals("application/dicom+json", seenAccept.get(), "Accept は dicom+json");
        } finally {
            server.stop(0);
        }
    }

    @Test
    void noMatches_returnsEmptyList() {
        // 204 相当（空ボディ）は空リスト
        assertTrue(WebDicomDataService.parseDatasets(new byte[0]).isEmpty());
        assertTrue(WebDicomDataService.parseDatasets(null).isEmpty());
    }
}

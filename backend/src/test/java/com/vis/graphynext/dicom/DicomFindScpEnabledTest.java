/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.net.Status;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.ServerSocket;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 設定で有効にしたとき、実際の起動経路（{@link DicomScpLifecycle}）で検索に応じること。
 * リスナーを直接組み立てる {@link DicomFindScpTest} と違い、設定の分岐を通る。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:findscp-on;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=true",
                "graphy.dicom.scp.bind-address=127.0.0.1",
                "graphy.dicom.scp.query-retrieve.enabled=true",
                "graphy.dicom.remote-aes[0].ae-title=LISTED",
                "graphy.dicom.remote-aes[0].host=127.0.0.1",
                "graphy.dicom.remote-aes[0].port=104"
        })
class DicomFindScpEnabledTest {

    static final int PORT = freePort();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.scp.port", () -> PORT);
        r.add("graphy.dicom.storage-dir", () -> System.getProperty("java.io.tmpdir") + "/graphy-findscp-on");
    }

    @Autowired
    DicomController controller;

    @Test
    void enabledByConfig_listedCallerIsAnswered_unlistedIsRefused_andStatusSaysActive() throws Exception {
        FindScpClient.Found ok = FindScpClient.find(PORT, UID.StudyRootQueryRetrieveInformationModelFind,
                "LISTED", studyKeys());
        assertTrue(ok.accepted(), "有効のとき FIND のコンテキストが受理される");
        assertEquals(Status.Success, ok.status());

        FindScpClient.Found refused = FindScpClient.find(PORT, UID.StudyRootQueryRetrieveInformationModelFind,
                "STRANGER", studyKeys());
        assertEquals(Status.UnableToProcess, refused.status(), "登録外の AE は拒否される");

        @SuppressWarnings("unchecked")
        Map<String, Object> qr = (Map<String, Object>) controller.scpStatus().get("queryRetrieve");
        assertEquals(Map.of("enabled", true, "active", true, "allowAll", false), qr);
    }

    private static Attributes studyKeys() {
        Attributes k = new Attributes();
        k.setString(Tag.QueryRetrieveLevel, VR.CS, "STUDY");
        k.setNull(Tag.StudyInstanceUID, VR.UI);
        return k;
    }

    private static int freePort() {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        } catch (Exception e) {
            throw new IllegalStateException("free port を確保できませんでした", e);
        }
    }
}

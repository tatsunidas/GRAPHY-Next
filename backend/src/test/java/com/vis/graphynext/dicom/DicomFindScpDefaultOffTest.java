/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.net.ServerSocket;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 何も設定しないとき（既定）は検索に応じないこと。登録済みの相手先からでも、FIND のコンテキストは受理されない。
 * 受信まわりの他の機能（C-ECHO）は従来どおり使える。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:findscp-off;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=true",
                "graphy.dicom.scp.bind-address=127.0.0.1",
                "graphy.dicom.remote-aes[0].ae-title=LISTED",
                "graphy.dicom.remote-aes[0].host=127.0.0.1",
                "graphy.dicom.remote-aes[0].port=104"
        })
class DicomFindScpDefaultOffTest {

    static final int PORT = freePort();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.scp.port", () -> PORT);
        r.add("graphy.dicom.storage-dir", () -> System.getProperty("java.io.tmpdir") + "/graphy-findscp-off");
    }

    @Autowired
    DicomController controller;
    @Autowired
    DicomEchoScu echo;

    @Test
    void defaultIsOff_findIsNotAccepted_evenForAListedCaller_butEchoStillWorks() throws Exception {
        Attributes keys = new Attributes();
        keys.setString(Tag.QueryRetrieveLevel, VR.CS, "STUDY");
        keys.setNull(Tag.StudyInstanceUID, VR.UI);
        FindScpClient.Found r = FindScpClient.find(PORT, UID.StudyRootQueryRetrieveInformationModelFind, "LISTED", keys);
        assertFalse(r.accepted(), "既定は OFF: 登録済みの相手でも FIND は使えない");
        assertEquals(0, r.matches().size());

        Attributes moveKeys = new Attributes(keys);
        moveKeys.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        MoveScpClient.Moved mv = MoveScpClient.move(PORT, UID.StudyRootQueryRetrieveInformationModelMove,
                "LISTED", "LISTED", moveKeys, 0);
        assertFalse(mv.accepted(), "既定は OFF: 登録済みの相手でも MOVE は使えない");

        assertTrue(echo.echo("127.0.0.1", PORT, "GRAPHYNEXT", "LISTED").success(), "C-ECHO は通る");

        @SuppressWarnings("unchecked")
        Map<String, Object> qr = (Map<String, Object>) controller.scpStatus().get("queryRetrieve");
        assertEquals(Map.of("enabled", false, "active", false, "allowAll", false), qr);
    }

    private static int freePort() {
        try (ServerSocket s = new ServerSocket(0)) {
            return s.getLocalPort();
        } catch (Exception e) {
            throw new IllegalStateException("free port を確保できませんでした", e);
        }
    }
}

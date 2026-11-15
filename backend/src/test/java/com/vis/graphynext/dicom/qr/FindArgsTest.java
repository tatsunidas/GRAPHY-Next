/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.qr;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class FindArgsTest {

    private static final List<String> STUDY_KEYS = List.of(
            "StudyInstanceUID", "PatientID", "PatientName", "PatientBirthDate", "PatientSex",
            "StudyDate", "StudyDescription", "AccessionNumber", "ModalitiesInStudy",
            "NumberOfStudyRelatedSeries", "NumberOfStudyRelatedInstances");
    private static final List<String> TLS = List.of("--key-store", "ks");

    /** 変更前の DimseQrService.findStudiesForQr / findSeries が組んでいた引数（参照実装。旧コードの写し）。 */
    private static List<String> oldStudy(Map<String, String> match, List<String> tls) {
        List<String> cmd = new ArrayList<>(List.of("findscu", "-b", "GRAPHYNEXT", "-c", "PACS@10.0.0.5:4000", "-L", "STUDY"));
        for (String key : STUDY_KEYS) {
            cmd.add("-r");
            cmd.add(key);
        }
        if (match != null) {
            match.forEach((k, v) -> {
                cmd.add("-m");
                cmd.add(k + "=" + v);
            });
        }
        cmd.add("--out-dir");
        cmd.add("/tmp/o");
        cmd.add("--out-file");
        cmd.add("rsp-0000.dcm");
        cmd.addAll(tls);
        return cmd;
    }

    private static List<String> oldSeries(String uid, Map<String, String> match, List<String> tls) {
        List<String> cmd = new ArrayList<>(List.of("findscu", "-b", "GRAPHYNEXT", "-c", "PACS@10.0.0.5:4000", "-L", "SERIES",
                "-m", "StudyInstanceUID=" + uid));
        for (String key : List.of("SeriesInstanceUID", "Modality")) {
            cmd.add("-r");
            cmd.add(key);
        }
        if (match != null) {
            match.forEach((k, v) -> {
                cmd.add("-m");
                cmd.add(k + "=" + v);
            });
        }
        cmd.add("--out-dir");
        cmd.add("/tmp/o");
        cmd.add("--out-file");
        cmd.add("rsp-0000.dcm");
        cmd.addAll(tls);
        return cmd;
    }

    @Test
    void defaultProfile_isIdenticalToOldArguments() {
        Map<String, String> match = new LinkedHashMap<>();
        match.put("PatientID", "*HCC*");
        match.put("StudyDate", "20261101-20261114");
        for (List<String> tls : List.of(List.<String>of(), TLS)) {
            assertEquals(oldStudy(match, tls), FindArgs.build("findscu", "GRAPHYNEXT", "PACS", "10.0.0.5", 4000, "STUDY",
                    FindProfile.DEFAULT, null, STUDY_KEYS, match, "/tmp/o", tls));
            assertEquals(oldStudy(null, tls), FindArgs.build("findscu", "GRAPHYNEXT", "PACS", "10.0.0.5", 4000, "STUDY",
                    null, null, STUDY_KEYS, null, "/tmp/o", tls));
            assertEquals(oldSeries("1.2.3", match, tls), FindArgs.build("findscu", "GRAPHYNEXT", "PACS", "10.0.0.5", 4000, "SERIES",
                    FindProfile.DEFAULT, Map.of("StudyInstanceUID", "1.2.3"), List.of("SeriesInstanceUID", "Modality"),
                    match, "/tmp/o", tls));
        }
    }

    @Test
    void optionsAppearOnlyWhenSet() {
        FindProfile p = new FindProfile("PatientRoot", null, null, null, null, "implicit", "ISO_IR 192", 5000);
        List<String> cmd = FindArgs.build("findscu", "GN", "PACS", "h", 1, "PATIENT", p, null,
                FindProfile.MINIMAL_PATIENT, Map.of(), "/o", List.of());
        assertTrue(cmd.containsAll(List.of("-M", "PatientRoot", "--implicit-vr", "--response-timeout", "5000")));
        assertTrue(cmd.contains("SpecificCharacterSet=ISO_IR 192"));
        assertEquals("PATIENT", cmd.get(cmd.indexOf("-L") + 1));
        assertEquals("PatientID", cmd.get(cmd.indexOf("-r") + 1));

        List<String> plain = FindArgs.build("findscu", "GN", "PACS", "h", 1, "STUDY", FindProfile.DEFAULT, null,
                FindProfile.MINIMAL_STUDY, Map.of(), "/o", List.of());
        for (String forbidden : List.of("-M", "--implicit-vr", "--explicit-vr", "--response-timeout")) {
            assertFalse(plain.contains(forbidden), forbidden);
        }
        assertTrue(FindArgs.build("findscu", "GN", "P", "h", 1, "STUDY",
                FindProfile.DEFAULT.withTransferSyntax("explicit"), null, FindProfile.MINIMAL_STUDY, Map.of(), "/o",
                List.of()).contains("--explicit-vr"));
    }

    @Test
    void profileJsonRoundTrip_andUnknownFieldsAreIgnored() throws Exception {
        var mapper = new com.fasterxml.jackson.databind.ObjectMapper();
        FindProfile p = FindProfile.DEFAULT.withModel("PatientRoot").withKeys(null, FindProfile.MINIMAL_STUDY, null);
        assertEquals(p, mapper.readValue(mapper.writeValueAsString(p), FindProfile.class));
        assertEquals("{}", mapper.writeValueAsString(FindProfile.DEFAULT));
        assertEquals(FindProfile.DEFAULT, mapper.readValue("{\"future\":1}", FindProfile.class));
    }
}

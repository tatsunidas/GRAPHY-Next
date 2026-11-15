/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.prefetch;

import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CsvAppointmentsTest {

    private static final LocalDate DAY = LocalDate.of(2026, 11, 10);

    @Test
    void 対象日の行だけが重複なしで残る_書式は3種類を受ける() {
        String csv = "﻿予約日,患者ID,名前\r\n2026/11/10,P001,山田\r\n20261110,P002,\"鈴木,太郎\"\r\n"
                + "2026-11-10,P001,山田\r\n2026/11/11,P003,佐藤\r\n";
        var p = CsvAppointments.parse(csv, "患者ID", "予約日", DAY);
        assertTrue(p.ok(), p.error());
        assertEquals(List.of("P001", "P002"), p.patientIds());
    }

    @Test
    void 予約日の列を指定しなければ全行が対象() {
        var p = CsvAppointments.parse("ID\nA1\nA2\n", "ID", null, DAY);
        assertEquals(List.of("A1", "A2"), p.patientIds());
    }

    @Test
    void 負例_列名が違えば拒否し_値を理由に含めない() {
        var p = CsvAppointments.parse("患者番号,予約日\nSECRET1,20261110\n", "患者ID", "予約日", DAY);
        assertFalse(p.ok());
        assertEquals(CsvAppointments.ERR_NO_ID_COLUMN, p.error());
        assertTrue(p.patientIds().isEmpty());
    }

    @Test
    void 負例_日付が読めない行が1つでもあれば全体を拒否する() {
        var p = CsvAppointments.parse("ID,D\nA1,20261110\nA2,来週\n", "ID", "D", DAY);
        assertEquals(CsvAppointments.ERR_BAD_DATE, p.error());
        assertFalse(p.error().contains("来週"));
    }

    @Test
    void 負例_患者IDが空か長すぎる行は拒否する() {
        assertEquals(CsvAppointments.ERR_BAD_ID, CsvAppointments.parse("ID\nA1\n\"\"\n", "ID", null, DAY).error());
        assertEquals(CsvAppointments.ERR_BAD_ID,
                CsvAppointments.parse("ID\n" + "X".repeat(65) + "\n", "ID", null, DAY).error());
    }

    @Test
    void 空のファイルは拒否する() {
        assertEquals(CsvAppointments.ERR_EMPTY, CsvAppointments.parse("", "ID", null, DAY).error());
    }
}

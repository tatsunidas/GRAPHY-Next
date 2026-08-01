/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.sr;

import com.vis.graphynext.dicom.sr.MeasurementReportRequest.Finding;
import com.vis.graphynext.dicom.sr.MeasurementReportRequest.Measurement;
import com.vis.graphynext.dicom.sr.MeasurementReportRequest.MeasurementGroup;
import com.vis.graphynext.dicom.sr.MeasurementReportRequest.Producer;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 計測レポート（DICOM SR）の構築を検証する。
 *
 * <p>主眼は 3 つ:
 * <ol>
 *   <li><b>計測値がそのまま入る</b>（丸めや取り違えで数字が変わらない）</li>
 *   <li><b>追跡 ID / 追跡 UID が入る</b>（時系列で同じ病変を結ぶ鍵。欠けると SR の価値が落ちる）</li>
 *   <li><b>患者・検査は元スタディから引き継ぐ</b>（別患者の SR を作らない）</li>
 * </ol>
 *
 * <p>保管庫を使わない（{@code build()} を直接呼ぶ）。保存経路は実機スパイクで確認する。
 */
class MeasurementReportServiceTest {

    private final MeasurementReportService service = new MeasurementReportService(null);
    private static final LocalDateTime NOW = LocalDateTime.of(2026, 8, 2, 10, 30, 0);

    private static Attributes template() {
        Attributes t = new Attributes();
        t.setSpecificCharacterSet("ISO_IR 192");
        t.setString(Tag.PatientID, VR.LO, "PAT-1");
        t.setString(Tag.PatientName, VR.PN, "Phantom^PartialResponse");
        t.setString(Tag.PatientBirthDate, VR.DA, "19700101");
        t.setString(Tag.PatientSex, VR.CS, "O");
        t.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3.4");
        t.setString(Tag.StudyDate, VR.DA, "20260105");
        t.setString(Tag.AccessionNumber, VR.SH, "ACC-1");
        t.setString(Tag.StudyDescription, VR.LO, "RECIST phantom");
        t.setString(Tag.Modality, VR.CS, "CT");
        t.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.4.5");
        return t;
    }

    private static MeasurementReportRequest request(List<MeasurementGroup> groups, List<Finding> findings) {
        return new MeasurementReportRequest(
                "1.2.3.4",
                "RECIST 1.1",
                "RECIST 1.1 measurement report",
                "Kobayashi^Tatsuaki",
                groups,
                findings,
                new Producer("lesion-evanesco", "Lesion Evanesco (RECIST 1.1)", "0.1.0"));
    }

    private static MeasurementGroup group(String trackingId, double longMm, Double shortMm) {
        return new MeasurementGroup(
                trackingId,
                null,
                "Target lesion",
                "1.2.3.4.9",
                "1.2.3.4.9.1",
                shortMm == null
                        ? List.of(new Measurement("longAxis", longMm, "mm"))
                        : List.of(new Measurement("longAxis", longMm, "mm"),
                                new Measurement("shortAxis", shortMm, "mm")));
    }

    /** 内容ツリーを深さ優先でたどり、概念名コードが一致する項目を集める。 */
    private static void collect(Attributes item, String codeValue, List<Attributes> out) {
        Sequence content = item.getSequence(Tag.ContentSequence);
        if (content == null) {
            return;
        }
        for (Attributes child : content) {
            Attributes name = child.getNestedDataset(Tag.ConceptNameCodeSequence);
            if (name != null && codeValue.equals(name.getString(Tag.CodeValue))) {
                out.add(child);
            }
            collect(child, codeValue, out);
        }
    }

    private static List<Attributes> find(Attributes root, String codeValue) {
        List<Attributes> out = new java.util.ArrayList<>();
        collect(root, codeValue, out);
        return out;
    }

    @Test
    void 患者と検査は元スタディから引き継ぐ() {
        Attributes sr = service.build(template(), request(List.of(group("1", 76.0, null)), null), NOW);
        assertEquals("PAT-1", sr.getString(Tag.PatientID));
        assertEquals("Phantom^PartialResponse", sr.getString(Tag.PatientName));
        assertEquals("1.2.3.4", sr.getString(Tag.StudyInstanceUID));
        assertEquals("ACC-1", sr.getString(Tag.AccessionNumber));
        // シリーズとインスタンスは新規採番。
        assertNotNull(sr.getString(Tag.SeriesInstanceUID));
        assertNotNull(sr.getString(Tag.SOPInstanceUID));
        assertFalse("1.2.3.4".equals(sr.getString(Tag.SeriesInstanceUID)));
    }

    @Test
    void SR文書としての基本属性が入る() {
        Attributes sr = service.build(template(), request(List.of(group("1", 76.0, null)), null), NOW);
        assertEquals("SR", sr.getString(Tag.Modality));
        assertEquals(UID.ComprehensiveSRStorage, sr.getString(Tag.SOPClassUID));
        assertEquals("CONTAINER", sr.getString(Tag.ValueType));
        assertEquals("COMPLETE", sr.getString(Tag.CompletionFlag));
        // **アプリが勝手に「検証済み」にしない**（読影医の確認行為を騙らない）。
        assertEquals("UNVERIFIED", sr.getString(Tag.VerificationFlag));
        assertEquals("20260802", sr.getString(Tag.ContentDate));
        assertEquals("103000", sr.getString(Tag.ContentTime));
        Attributes rootName = sr.getNestedDataset(Tag.ConceptNameCodeSequence);
        assertEquals("126000", rootName.getString(Tag.CodeValue));
    }

    @Test
    void 計測値がそのまま入る() {
        Attributes sr = service.build(template(), request(List.of(group("1", 76.05, 24.5)), null), NOW);
        List<Attributes> longAxis = find(sr, "G-A185");
        List<Attributes> shortAxis = find(sr, "G-A186");
        assertEquals(1, longAxis.size());
        assertEquals(1, shortAxis.size());
        assertEquals("NUM", longAxis.get(0).getString(Tag.ValueType));
        Attributes measured = longAxis.get(0).getNestedDataset(Tag.MeasuredValueSequence);
        assertEquals("76.05", measured.getString(Tag.NumericValue));
        Attributes unit = measured.getNestedDataset(Tag.MeasurementUnitsCodeSequence);
        assertEquals("mm", unit.getString(Tag.CodeValue));
        assertEquals("UCUM", unit.getString(Tag.CodingSchemeDesignator));
        assertEquals("24.5",
                shortAxis.get(0).getNestedDataset(Tag.MeasuredValueSequence).getString(Tag.NumericValue));
    }

    @Test
    void 追跡IDと追跡UIDが入る() {
        Attributes sr = service.build(template(), request(List.of(group("3", 30.0, null)), null), NOW);
        List<Attributes> ids = find(sr, "112039");
        assertEquals(1, ids.size());
        assertEquals("3", ids.get(0).getString(Tag.TextValue));
        List<Attributes> uids = find(sr, "112040");
        assertEquals(1, uids.size());
        assertEquals("UIDREF", uids.get(0).getString(Tag.ValueType));
        // 省略時は本体が採番する（空のまま出さない）。
        assertNotNull(uids.get(0).getString(Tag.UID));
        assertFalse(uids.get(0).getString(Tag.UID).isBlank());
    }

    @Test
    void 追跡UIDを指定すればその値を使う() {
        MeasurementGroup g = new MeasurementGroup("1", "9.9.9.9", "Target lesion", "1.2.3.4.9", "1.2.3.4.9.1",
                List.of(new Measurement("longAxis", 10.0, "mm")));
        Attributes sr = service.build(template(), request(List.of(g), null), NOW);
        assertEquals("9.9.9.9", find(sr, "112040").get(0).getString(Tag.UID));
    }

    @Test
    void 病変ごとに計測グループができる() {
        Attributes sr = service.build(template(),
                request(List.of(group("1", 76.0, null), group("2", 30.0, null)), null), NOW);
        assertEquals(2, find(sr, "125007").size());
        assertEquals(2, find(sr, "112039").size());
    }

    @Test
    void 計測した画像への参照が入る() {
        Attributes sr = service.build(template(), request(List.of(group("1", 76.0, null)), null), NOW);
        // 計測グループ内の Source of Measurement。
        List<Attributes> src = find(sr, "121112");
        assertEquals(1, src.size());
        assertEquals("IMAGE", src.get(0).getString(Tag.ValueType));
        assertEquals("1.2.3.4.9.1",
                src.get(0).getNestedDataset(Tag.ReferencedSOPSequence).getString(Tag.ReferencedSOPInstanceUID));

        // 画像ライブラリ。
        assertEquals(1, find(sr, "111028").size());

        // 証跡（SR だけを受け取った側が元画像へ辿れる）。
        Attributes evid = sr.getNestedDataset(Tag.CurrentRequestedProcedureEvidenceSequence);
        assertNotNull(evid);
        assertEquals("1.2.3.4", evid.getString(Tag.StudyInstanceUID));
        Attributes series = evid.getNestedDataset(Tag.ReferencedSeriesSequence);
        assertEquals("1.2.3.4.9", series.getString(Tag.SeriesInstanceUID));
    }

    @Test
    void 同じ画像を参照する病変が複数あっても画像ライブラリは重複しない() {
        Attributes sr = service.build(template(),
                request(List.of(group("1", 76.0, null), group("2", 30.0, null)), null), NOW);
        Attributes lib = find(sr, "111028").get(0);
        Attributes libGroup = lib.getSequence(Tag.ContentSequence).get(0);
        assertEquals(1, libGroup.getSequence(Tag.ContentSequence).size());
    }

    @Test
    void 所見テキストが入る() {
        Attributes sr = service.build(template(), request(
                List.of(group("1", 76.0, null)),
                List.of(new Finding("Best overall response", "PR"), new Finding("Baseline", "SLD 100.0 mm"))), NOW);
        List<Attributes> comments = find(sr, "121106");
        // タイトル 1 件 ＋ 所見 2 件。
        assertEquals(3, comments.size());
        assertTrue(comments.stream().anyMatch(c -> "Best overall response: PR".equals(c.getString(Tag.TextValue))));
    }

    @Test
    void 空の所見は落とす() {
        Attributes sr = service.build(template(), request(
                List.of(group("1", 76.0, null)),
                List.of(new Finding("x", "  "), new Finding("y", "ok"))), NOW);
        assertEquals(1, find(sr, "121106").stream()
                .filter(c -> c.getString(Tag.TextValue).startsWith("y")).count());
    }

    @Test
    void 出所がプラグインなら接頭辞と機器情報が入る() {
        Attributes sr = service.build(template(), request(List.of(group("1", 76.0, null)), null), NOW);
        assertTrue(sr.getString(Tag.SeriesDescription).startsWith("[Plugin] "));
        Attributes eq = sr.getNestedDataset(Tag.ContributingEquipmentSequence);
        assertNotNull(eq);
        assertEquals("Lesion Evanesco (RECIST 1.1)", eq.getString(Tag.ManufacturerModelName));
        assertEquals("0.1.0", eq.getString(Tag.SoftwareVersions));
    }

    @Test
    void 出所が無ければ接頭辞を付けない() {
        MeasurementReportRequest req = new MeasurementReportRequest(
                "1.2.3.4", "Manual", null, null, List.of(group("1", 10.0, null)), null, null);
        Attributes sr = service.build(template(), req, NOW);
        assertEquals("Manual", sr.getString(Tag.SeriesDescription));
        assertNull(sr.getNestedDataset(Tag.ContributingEquipmentSequence));
    }

    @Test
    void 観測者名は任意() {
        MeasurementReportRequest req = new MeasurementReportRequest(
                "1.2.3.4", null, null, "  ", List.of(group("1", 10.0, null)), null, null);
        Attributes sr = service.build(template(), req, NOW);
        assertTrue(find(sr, "121008").isEmpty());
    }

    @Test
    void 数値の書式はDSに収まる() {
        assertEquals("76", MeasurementReportService.trimNumber(76.0));
        assertEquals("76.05", MeasurementReportService.trimNumber(76.05));
        assertEquals("0", MeasurementReportService.trimNumber(0));
        assertTrue(MeasurementReportService.trimNumber(1234567890.123456).length() <= 16);
    }

    @Test
    void 未知の計測種別は拒否する() {
        MeasurementGroup g = new MeasurementGroup("1", null, null, "s", "i",
                List.of(new Measurement("volume", 10.0, "ml")));
        // **黙って落とさない**。落とすと「入れたはずの計測が無い SR」ができる。
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> service.create(request(List.of(g), null)));
        assertTrue(e.getMessage().contains("volume"));
    }

    @Test
    void 中身が無い要求は拒否する() {
        assertThrows(IllegalArgumentException.class,
                () -> service.create(request(List.of(), List.of())));
        assertThrows(IllegalArgumentException.class,
                () -> service.create(new MeasurementReportRequest(null, null, null, null,
                        List.of(group("1", 10.0, null)), null, null)));
    }

    @Test
    void 追跡IDが無いグループは拒否する() {
        MeasurementGroup g = new MeasurementGroup("  ", null, null, "s", "i",
                List.of(new Measurement("longAxis", 10.0, "mm")));
        assertThrows(IllegalArgumentException.class, () -> service.create(request(List.of(g), null)));
    }

    @Test
    void 計測が空のグループは拒否する() {
        MeasurementGroup g = new MeasurementGroup("1", null, null, "s", "i", List.of());
        assertThrows(IllegalArgumentException.class, () -> service.create(request(List.of(g), null)));
    }

    @Test
    void 負の計測値は拒否する() {
        MeasurementGroup g = new MeasurementGroup("1", null, null, "s", "i",
                List.of(new Measurement("longAxis", -1.0, "mm")));
        assertThrows(IllegalArgumentException.class, () -> service.create(request(List.of(g), null)));
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.sr;

import com.vis.graphynext.dicom.sr.MeasurementReportRequest.Finding;
import com.vis.graphynext.dicom.sr.MeasurementReportRequest.Measurement;
import com.vis.graphynext.dicom.sr.MeasurementReportRequest.MeasurementGroup;
import com.vis.graphynext.dicom.sr.MeasurementReportRequest.Producer;
import com.vis.graphynext.dicom.sr.SrContentReader.Node;
import com.vis.graphynext.dicom.sr.SrContentReader.SrDocument;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SR の内容の木の読み取り。**本体自身が書く SR（{@link MeasurementReportService}）を読み戻し**、書いた内容と一致することを確かめる。
 * 負例: SR でない DICOM は断る。深さ・項目数・テキストの長さの上限は、黙って切らず、理由つきで知らせる。
 */
class SrContentReaderTest {

    private final MeasurementReportService service = new MeasurementReportService(null);
    private static final LocalDateTime NOW = LocalDateTime.of(2026, 8, 2, 10, 30, 0);

    private static Attributes template() {
        Attributes t = new Attributes();
        t.setSpecificCharacterSet("ISO_IR 192");
        t.setString(Tag.PatientID, VR.LO, "PAT-1");
        t.setString(Tag.PatientName, VR.PN, "Phantom^PartialResponse");
        t.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3.4");
        t.setString(Tag.StudyDate, VR.DA, "20260105");
        t.setString(Tag.Modality, VR.CS, "CT");
        t.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.4.5");
        return t;
    }

    private SrDocument readBuilt(List<MeasurementGroup> groups, List<Finding> findings) {
        MeasurementReportRequest req = new MeasurementReportRequest("1.2.3.4", "Dosimetry cycle 1",
                "Dosimetry cycle 1 (Lu-177, 7400 MBq)", "Kobayashi^Tatsuaki", groups, findings,
                new Producer("dosimetry", "Dosimetry", "0.1.4"));
        return SrContentReader.read(service.build(template(), req, NOW));
    }

    private static void find(Node n, String conceptCode, List<Node> out) {
        if (n.concept() != null && conceptCode.equals(n.concept().value())) {
            out.add(n);
        }
        for (Node c : n.children()) {
            find(c, conceptCode, out);
        }
    }

    private static List<Node> all(SrDocument d, String conceptCode) {
        List<Node> out = new ArrayList<>();
        find(d.root(), conceptCode, out);
        return out;
    }

    @Test
    void 本体が書いた_SR_を読み戻すと_ヘッダと内容が一致する() {
        SrDocument d = readBuilt(
                List.of(new MeasurementGroup("cycle=1;voi=liver", null, "label=liver;dose=1.3215094748221",
                        "1.2.3.4.9", "1.2.3.4.9.1",
                        List.of(new Measurement("absorbedDose", 1.3215, "Gy"), new Measurement("effectiveHalfLife", 58.7346, "h")))),
                List.of(new Finding("cycle", "1"), new Finding("activity-mbq", "7400")));
        assertEquals(UID.ComprehensiveSRStorage, d.header().sopClassUid());
        assertEquals("Comprehensive SR", d.header().sopClassName());
        assertEquals("COMPLETE", d.header().completionFlag());
        assertEquals("UNVERIFIED", d.header().verificationFlag());
        assertEquals("20260802", d.header().contentDate());
        assertEquals("1.2.3.4", d.header().studyInstanceUid());
        assertEquals("CONTAINER", d.root().valueType());
        assertFalse(d.truncated());
        assertTrue(d.itemCount() > 8);

        // 所見（Comment）
        List<Node> findings = all(d, "121070");
        assertEquals(1, findings.size());
        List<String> comments = findings.get(0).children().stream().map(Node::text).toList();
        assertEquals(List.of("cycle: 1", "activity-mbq: 7400"), comments);

        // 追跡 ID・所見・数値（値と単位コード）
        assertEquals("cycle=1;voi=liver", all(d, "112039").get(0).text());
        assertEquals("label=liver;dose=1.3215094748221", all(d, "121071").get(0).text());
        Node dose = all(d, "ABSORBED_DOSE").get(0);
        assertEquals("NUM", dose.valueType());
        assertEquals("1.3215", dose.num().value());
        assertEquals("Gy", dose.num().unit().value());
        assertEquals("UCUM", dose.num().unit().scheme());
        assertEquals("58.7346", all(d, "T_EFF").get(0).num().value());
        // UIDREF（追跡 UID）と、計測した画像への参照（IMAGE）
        assertEquals("UIDREF", all(d, "112040").get(0).valueType());
        assertNotNull(all(d, "112040").get(0).uid());
        List<Node> src = all(d, "121112");
        assertEquals(1, src.size());
        assertEquals("1.2.3.4.9.1", src.get(0).ref().sopInstanceUid());
        // 患者名・ID は返さない（型に欄が無い）
        assertFalse(d.toString().contains("Phantom^PartialResponse"));
        assertFalse(d.toString().contains("PAT-1"));
    }

    @Test
    void 日本語と記号を含む文字列も_そのまま読める() {
        SrDocument d = readBuilt(List.of(), List.of(new Finding("メモ", "左腎; <b>x</b> & \"q\"")));
        String text = all(d, "121070").get(0).children().get(0).text();
        assertEquals("メモ: 左腎; <b>x</b> & \"q\"", text);
    }

    @Test
    void 負例_SR_でない_DICOM_は断る() {
        Attributes ct = new Attributes();
        ct.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        assertThrows(SrContentReader.NotSrException.class, () -> SrContentReader.read(ct));
        Attributes empty = new Attributes();
        assertThrows(SrContentReader.NotSrException.class, () -> SrContentReader.read(empty));
        // SR の SOP クラスでも、内容（ValueType）が無ければ断る
        Attributes noContent = new Attributes();
        noContent.setString(Tag.SOPClassUID, VR.UI, UID.ComprehensiveSRStorage);
        assertThrows(SrContentReader.NotSrException.class, () -> SrContentReader.read(noContent));
    }

    private static Attributes container() {
        Attributes c = new Attributes();
        c.setString(Tag.ValueType, VR.CS, "CONTAINER");
        return c;
    }

    private static Attributes srRoot() {
        Attributes r = container();
        r.setString(Tag.SOPClassUID, VR.UI, UID.BasicTextSRStorage);
        return r;
    }

    @Test
    void 負例_入れ子が深すぎる_SR_は_黙って切らず_理由つきで知らせる() {
        Attributes root = srRoot();
        Attributes cur = root;
        for (int i = 0; i < SrContentReader.MAX_DEPTH + 6; i++) {
            Attributes child = container();
            child.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
            cur.newSequence(Tag.ContentSequence, 1).add(child);
            cur = child;
        }
        SrDocument d = SrContentReader.read(root);
        assertTrue(d.truncated());
        assertTrue(d.truncatedReason().contains("深さ"), d.truncatedReason());
        assertTrue(d.itemCount() <= SrContentReader.MAX_DEPTH + 2);
    }

    @Test
    void 負例_項目が多すぎる_SR_は_上限で止め_理由つきで知らせる() {
        Attributes root = srRoot();
        Sequence seq = root.newSequence(Tag.ContentSequence, SrContentReader.MAX_ITEMS + 50);
        for (int i = 0; i < SrContentReader.MAX_ITEMS + 50; i++) {
            Attributes t = new Attributes();
            t.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
            t.setString(Tag.ValueType, VR.CS, "TEXT");
            t.setString(Tag.TextValue, VR.UT, "x");
            seq.add(t);
        }
        SrDocument d = SrContentReader.read(root);
        assertTrue(d.truncated());
        assertTrue(d.truncatedReason().contains("項目数"), d.truncatedReason());
        assertEquals(SrContentReader.MAX_ITEMS, d.itemCount());
    }

    @Test
    void 負例_長すぎるテキストは_上限で切り_理由つきで知らせる() {
        Attributes root = srRoot();
        Attributes t = new Attributes();
        t.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
        t.setString(Tag.ValueType, VR.CS, "TEXT");
        t.setString(Tag.TextValue, VR.UT, "a".repeat(SrContentReader.MAX_TEXT_CHARS + 10));
        root.newSequence(Tag.ContentSequence, 1).add(t);
        SrDocument d = SrContentReader.read(root);
        assertTrue(d.truncated());
        assertEquals(SrContentReader.MAX_TEXT_CHARS, d.root().children().get(0).text().length());
    }

    @Test
    void 制限内の_SR_は切り詰め_なし() {
        SrDocument d = readBuilt(List.of(), List.of(new Finding("a", "b")));
        assertFalse(d.truncated());
        assertEquals(null, d.truncatedReason());
    }

    @Test
    void 各値の型_NUM以外_を読める() {
        Attributes root = srRoot();
        Sequence seq = root.newSequence(Tag.ContentSequence, 6);
        seq.add(item("CODE", a -> a.newSequence(Tag.ConceptCodeSequence, 1)
                .add(code("T-28000", "SRT", "Liver"))));
        seq.add(item("DATE", a -> a.setString(Tag.Date, VR.DA, "20260801")));
        seq.add(item("TIME", a -> a.setString(Tag.Time, VR.TM, "090000")));
        seq.add(item("DATETIME", a -> a.setString(Tag.DateTime, VR.DT, "20260801090000")));
        seq.add(item("PNAME", a -> a.setString(Tag.PersonName, VR.PN, "Doe^Jane")));
        seq.add(item("SCOORD", a -> {
            a.setString(Tag.GraphicType, VR.CS, "POLYLINE");
            a.setFloat(Tag.GraphicData, VR.FL, 1f, 2f, 3f, 4f);
        }));
        SrDocument d = SrContentReader.read(root);
        List<Node> c = d.root().children();
        assertEquals("Liver", c.get(0).code().meaning());
        assertEquals("20260801", c.get(1).date());
        assertEquals("090000", c.get(2).time());
        assertEquals("20260801090000", c.get(3).dateTime());
        assertEquals("Doe^Jane", c.get(4).personName());
        assertEquals("POLYLINE", c.get(5).graphic().type());
        assertEquals(List.of(1.0, 2.0, 3.0, 4.0), c.get(5).graphic().data());
    }

    private static Attributes item(String type, java.util.function.Consumer<Attributes> fill) {
        Attributes a = new Attributes();
        a.setString(Tag.RelationshipType, VR.CS, "CONTAINS");
        a.setString(Tag.ValueType, VR.CS, type);
        fill.accept(a);
        return a;
    }

    private static Attributes code(String v, String s, String m) {
        Attributes c = new Attributes();
        c.setString(Tag.CodeValue, VR.SH, v);
        c.setString(Tag.CodingSchemeDesignator, VR.SH, s);
        c.setString(Tag.CodeMeaning, VR.LO, m);
        return c;
    }
}

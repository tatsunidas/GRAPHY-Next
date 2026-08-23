/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * GSPS 読み込み（§14.1 / A10）。
 *
 * <h3>🚨 往復が通るだけでは足りない</h3>
 * 自分が書いたものを自分で読めるのは当たり前で、**読み込みの価値は他社が書いたものを
 * 適用できること**にある。だから「解釈しない項目を落としたと言えるか」を同じ重さで検査する。
 */
class XaPresentationStateReaderTest {

    private static Attributes template() {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, "1.2.840.10008.5.1.4.1.1.12.1");
        ds.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        ds.setString(Tag.PatientID, VR.LO, "P001");
        ds.setInt(Tag.Rows, VR.US, 512);
        ds.setInt(Tag.Columns, VR.US, 512);
        return ds;
    }

    private static AngioPresentationRequest request() {
        return new AngioPresentationRequest(
                "1.2.3", "1.2.3.9", "1.2.3.10", List.of(1, 2, 3),
                "run 1", "DSA + QCA", "GRAPHY",
                new AngioPresentationRequest.Voi(1200, 900),
                true, 90, true,
                new AngioPresentationRequest.Mask(List.of(1, 2), 1.5, -2.5, "AVG_SUB"),
                new AngioPresentationRequest.Calibration(0.225, 0.225, "GEOMETRY", "6Fr catheter"),
                List.of(new AngioPresentationRequest.Polyline(
                        "QCA", List.of(10.0, 20.0, 11.5, 21.5, 13.0, 23.0), false, null)),
                List.of(new AngioPresentationRequest.TextAnnotation("QCA", "MLD 1.24 mm", 30.0, 40.0)));
    }

    private static XaPresentationState roundTrip() {
        var built = XaPresentationStateWriter.build(template(), request(), 512, 512);
        return XaPresentationStateReader.read(built.dataset());
    }

    @Test
    void 書いたものをそのまま読み戻せる() {
        XaPresentationState st = roundTrip();
        assertEquals(1, st.referencedImages().size());
        assertEquals("1.2.3.10", st.referencedImages().get(0).sopInstanceUid());
        assertEquals("1.2.3.9", st.referencedImages().get(0).seriesInstanceUid());
        assertEquals(List.of(1, 2, 3), st.referencedImages().get(0).frameNumbers());
        assertNotNull(st.voi());
        assertEquals(1200, st.voi().windowCenter(), 1e-6);
        assertEquals(900, st.voi().windowWidth(), 1e-6);
        assertTrue(st.invert());
        assertEquals(90, st.rotation());
        assertTrue(st.flipHorizontal());
        assertNotNull(st.calibration());
        assertEquals(0.225, st.calibration().mmPerPxRow(), 1e-9);
    }

    @Test
    void DSAのマスクとピクセルシフトが戻る() {
        // 🚨 これが XA/XRF GSPS（11.5）を選んだ理由そのもの。ここが壊れると A2 が再現できない。
        XaPresentationState st = roundTrip();
        assertNotNull(st.mask());
        assertEquals(List.of(1, 2), st.mask().maskFrameNumbers());
        assertEquals("AVG_SUB", st.mask().operation());
        // MaskSubPixelShift は [row, column]。並びを取り違えると体動補正が 90° 回る。
        assertEquals(1.5, st.mask().subPixelShiftRow(), 1e-6);
        assertEquals(-2.5, st.mask().subPixelShiftCol(), 1e-6);
        assertEquals(1, st.mask().applicableFrom());
        assertEquals(3, st.mask().applicableTo());
    }

    @Test
    void 図形の座標が画素座標へ戻る() {
        // PIXEL 単位は画素中心 1.0 起点。writer が +0.5 しているので reader は −0.5 する。
        // ここがずれると、線が半画素ずれた場所に出る（見た目では気づけない量）。
        XaPresentationState st = roundTrip();
        assertEquals(1, st.polylines().size());
        assertEquals(List.of(10.0, 20.0, 11.5, 21.5, 13.0, 23.0), st.polylines().get(0).points());
        assertEquals("POLYLINE", st.polylines().get(0).graphicType());
        assertEquals(1, st.texts().size());
        assertEquals("MLD 1.24 mm", st.texts().get(0).text());
        assertEquals(30.0, st.texts().get(0).anchorX(), 1e-5);
        assertEquals(40.0, st.texts().get(0).anchorY(), 1e-5);
    }

    @Test
    void 非減算なら黙って減算にしない() {
        AngioPresentationRequest req = new AngioPresentationRequest(
                "1.2.3", "1.2.3.9", "1.2.3.10", List.of(1),
                "run", null, null, null, false, 0, false,
                null, null, List.of(), List.of());
        var built = XaPresentationStateWriter.build(template(), req, 512, 512);
        XaPresentationState st = XaPresentationStateReader.read(built.dataset());
        assertNull(st.mask());
        assertNull(st.voi());
        assertFalse(st.invert());
        assertEquals(0, st.rotation());
        assertTrue(st.warnings().isEmpty(), st.warnings().toString());
    }

    @Test
    void 表示状態でないものは読めたことにしない() {
        Attributes notPr = template();
        IllegalArgumentException e =
                assertThrows(IllegalArgumentException.class, () -> XaPresentationStateReader.read(notPr));
        assertTrue(e.getMessage().contains("1.2.840.10008.5.1.4.1.1.12.1"), e.getMessage());
    }

    @Test
    void VOIがLUTで書かれていたら近似せず警告する() {
        // 🚨 曲線を W/L に潰すと**別の絵**になる。「だいたい合わせる」をやらない。
        var built = XaPresentationStateWriter.build(template(), request(), 512, 512);
        Attributes ds = built.dataset();
        Attributes voiItem = ds.getSequence(Tag.SoftcopyVOILUTSequence).get(0);
        voiItem.remove(Tag.WindowCenter);
        voiItem.remove(Tag.WindowWidth);
        Attributes lut = new Attributes();
        lut.setInt(Tag.LUTDescriptor, VR.US, 256, 0, 8);
        voiItem.newSequence(Tag.VOILUTSequence, 1).add(lut);

        XaPresentationState st = XaPresentationStateReader.read(ds);
        assertNull(st.voi());
        assertTrue(st.warnings().contains("voiLutData"), st.warnings().toString());
    }

    @Test
    void DISPLAY単位の図形は貼らずに警告する() {
        // 表示面に対する割合なので、こちらの表示ジオメトリでは同じ場所に来ない。
        var built = XaPresentationStateWriter.build(template(), request(), 512, 512);
        Attributes ds = built.dataset();
        Attributes obj = ds.getSequence(Tag.GraphicAnnotationSequence).get(0)
                .getSequence(Tag.GraphicObjectSequence).get(0);
        obj.setString(Tag.GraphicAnnotationUnits, VR.CS, "DISPLAY");

        XaPresentationState st = XaPresentationStateReader.read(ds);
        assertTrue(st.polylines().isEmpty());
        assertTrue(st.warnings().stream().anyMatch(w -> w.startsWith("graphicUnits:")), st.warnings().toString());
        assertTrue(st.warnings().toString().contains("DISPLAY"), st.warnings().toString());
    }

    @Test
    void シャッターと通常GSPSを警告する() {
        var built = XaPresentationStateWriter.build(template(), request(), 512, 512);
        Attributes ds = built.dataset();
        // 他社が 11.1（Mask モジュールが無い）で書いてくることがある。
        ds.setString(Tag.SOPClassUID, VR.UI, "1.2.840.10008.5.1.4.1.1.11.1");
        ds.setString(Tag.ShutterShape, VR.CS, "RECTANGULAR");

        XaPresentationState st = XaPresentationStateReader.read(ds);
        assertTrue(st.warnings().contains("notXaGsps"), st.warnings().toString());
        assertTrue(st.warnings().contains("displayShutter"), st.warnings().toString());
    }

    @Test
    void 参照画像が複数あることを黙って捨てない() {
        var built = XaPresentationStateWriter.build(template(), request(), 512, 512);
        Attributes ds = built.dataset();
        Attributes refSeries = ds.getSequence(Tag.ReferencedSeriesSequence).get(0);
        Attributes second = new Attributes();
        second.setString(Tag.ReferencedSOPClassUID, VR.UI, "1.2.840.10008.5.1.4.1.1.12.1");
        second.setString(Tag.ReferencedSOPInstanceUID, VR.UI, "1.2.3.11");
        refSeries.getSequence(Tag.ReferencedImageSequence).add(second);

        XaPresentationState st = XaPresentationStateReader.read(ds);
        assertEquals(2, st.referencedImages().size());
        assertTrue(st.warnings().contains("multipleReferencedImages"), st.warnings().toString());
    }
}

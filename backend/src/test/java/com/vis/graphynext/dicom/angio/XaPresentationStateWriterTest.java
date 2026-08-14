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
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * XA/XRF GSPS の書き出し（{@code fw/angio-design.md} §14.1 / A10）。
 *
 * <p>ここが壊れると「保存した DSA 設定・計測が開き直せない」形で効く。しかも保存自体は
 * 成功して見えるので気づきにくい。
 */
class XaPresentationStateWriterTest {

    private static Attributes xaTemplate() {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, "1.2.840.10008.5.1.4.1.1.12.1");
        ds.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.10");
        ds.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        ds.setString(Tag.PatientID, VR.LO, "P001");
        ds.setString(Tag.PatientName, VR.PN, "Test^Patient");
        ds.setInt(Tag.Rows, VR.US, 512);
        ds.setInt(Tag.Columns, VR.US, 512);
        return ds;
    }

    private static AngioPresentationRequest req(AngioPresentationRequest.Mask mask,
                                                AngioPresentationRequest.Calibration cal) {
        return new AngioPresentationRequest(
                "1.2.3", "1.2.3.9", "1.2.3.10", List.of(1, 2, 3),
                "QCA run 1", "QCA of LAD", "Tester",
                new AngioPresentationRequest.Voi(120, 400),
                true, 90, true, mask, cal,
                List.of(new AngioPresentationRequest.Polyline("QCA", List.of(10.0, 20.0, 30.0, 40.0), false, null)),
                List.of(new AngioPresentationRequest.TextAnnotation("QCA", "%DS 52.3", 30.0, 40.0)));
    }

    @Test
    void writesXaXrfGspsSopClass() {
        // 通常の GSPS(11.1) ではなく XA/XRF GSPS(11.5)。Mask を持てるのがこれだけ。
        var r = XaPresentationStateWriter.build(xaTemplate(), req(null, null), 512, 512);
        assertEquals("1.2.840.10008.5.1.4.1.1.11.5", r.dataset().getString(Tag.SOPClassUID));
        assertEquals("PR", r.dataset().getString(Tag.Modality));
        assertNotNull(r.sopInstanceUid());
        assertNotNull(r.seriesInstanceUid());
    }

    @Test
    void inheritsPatientAndStudyIdentity() {
        // 別患者に紐づく事故を防ぐ。
        var r = XaPresentationStateWriter.build(xaTemplate(), req(null, null), 512, 512);
        assertEquals("P001", r.dataset().getString(Tag.PatientID));
        assertEquals("1.2.3", r.dataset().getString(Tag.StudyInstanceUID));
    }

    @Test
    void referencesTheImageAndFrames() {
        var r = XaPresentationStateWriter.build(xaTemplate(), req(null, null), 512, 512);
        Attributes refSeries = r.dataset().getNestedDataset(Tag.ReferencedSeriesSequence);
        assertEquals("1.2.3.9", refSeries.getString(Tag.SeriesInstanceUID));
        Attributes refImage = refSeries.getNestedDataset(Tag.ReferencedImageSequence);
        assertEquals("1.2.3.10", refImage.getString(Tag.ReferencedSOPInstanceUID));
        assertArrayEqualsInt(new int[] {1, 2, 3}, refImage.getInts(Tag.ReferencedFrameNumber));
    }

    @Test
    void storesMaskForDsa() {
        // ★ XA/XRF GSPS を選んだ理由。ここが落ちると DSA 設定を再現できない。
        var mask = new AngioPresentationRequest.Mask(List.of(2, 3, 4), 0.5, -1.25, null);
        var r = XaPresentationStateWriter.build(xaTemplate(), req(mask, null), 512, 512);
        Attributes m = r.dataset().getNestedDataset(Tag.MaskSubtractionSequence);
        assertNotNull(m);
        assertEquals("AVG_SUB", m.getString(Tag.MaskOperation));
        assertArrayEqualsInt(new int[] {2, 3, 4}, m.getInts(Tag.MaskFrameNumbers));
        // MaskSubPixelShift は [row, column]。frontend の {dx=横, dy=縦} と並びが逆。
        float[] shift = m.getFloats(Tag.MaskSubPixelShift);
        assertEquals(0.5f, shift[0], 1e-6);
        assertEquals(-1.25f, shift[1], 1e-6);
        assertArrayEqualsInt(new int[] {1, 3}, m.getInts(Tag.ApplicableFrameRange));
        assertEquals("SUB", r.dataset().getString(Tag.RecommendedViewingMode));
    }

    @Test
    void withoutMaskIsNativeViewing() {
        var r = XaPresentationStateWriter.build(xaTemplate(), req(null, null), 512, 512);
        assertNull(r.dataset().getSequence(Tag.MaskSubtractionSequence));
        assertEquals("NAT", r.dataset().getString(Tag.RecommendedViewingMode));
    }

    @Test
    void storesCalibrationAsPresentationPixelSpacing() {
        // A3 の「校正値の永続化」はここで満たす（開き直しても同じ長さが出る）。
        var cal = new AngioPresentationRequest.Calibration(0.208, 0.208, "FIDUCIAL", "6Fr catheter");
        var r = XaPresentationStateWriter.build(xaTemplate(), req(null, cal), 512, 512);
        Attributes area = r.dataset().getNestedDataset(Tag.DisplayedAreaSelectionSequence);
        double[] ps = area.getDoubles(Tag.PresentationPixelSpacing);
        assertEquals(0.208, ps[0], 1e-9);
        assertEquals(0.208, ps[1], 1e-9);
    }

    @Test
    void displayedAreaCoversTheWholeImage() {
        var r = XaPresentationStateWriter.build(xaTemplate(), req(null, null), 512, 512);
        Attributes area = r.dataset().getNestedDataset(Tag.DisplayedAreaSelectionSequence);
        assertArrayEqualsInt(new int[] {1, 1}, area.getInts(Tag.DisplayedAreaTopLeftHandCorner));
        assertArrayEqualsInt(new int[] {512, 512}, area.getInts(Tag.DisplayedAreaBottomRightHandCorner));
        assertEquals("SCALE TO FIT", area.getString(Tag.PresentationSizeMode));
    }

    @Test
    void storesVoiInvertAndTransform() {
        var r = XaPresentationStateWriter.build(xaTemplate(), req(null, null), 512, 512);
        Attributes voi = r.dataset().getNestedDataset(Tag.SoftcopyVOILUTSequence);
        assertEquals(120.0, voi.getDouble(Tag.WindowCenter, 0), 1e-9);
        assertEquals(400.0, voi.getDouble(Tag.WindowWidth, 0), 1e-9);
        assertEquals("INVERSE", r.dataset().getString(Tag.PresentationLUTShape));
        assertEquals(90, r.dataset().getInt(Tag.ImageRotation, -1));
        assertEquals("Y", r.dataset().getString(Tag.ImageHorizontalFlip));
    }

    @Test
    void graphicsUsePixelUnitsWithHalfPixelOffset() {
        // GSPS の PIXEL 単位は「左上画素の中心 = (0.5,0.5)」。0 origin の画素座標から +0.5 する。
        var r = XaPresentationStateWriter.build(xaTemplate(), req(null, null), 512, 512);
        Attributes ann = r.dataset().getNestedDataset(Tag.GraphicAnnotationSequence);
        assertEquals("QCA", ann.getString(Tag.GraphicLayer));
        Attributes g = ann.getNestedDataset(Tag.GraphicObjectSequence);
        assertEquals("PIXEL", g.getString(Tag.GraphicAnnotationUnits));
        assertEquals("POLYLINE", g.getString(Tag.GraphicType));
        assertEquals(2, g.getInt(Tag.NumberOfGraphicPoints, 0));
        float[] data = g.getFloats(Tag.GraphicData);
        assertEquals(10.5f, data[0], 1e-6);
        assertEquals(20.5f, data[1], 1e-6);
        // テキストのアンカーも同じ規約。
        Attributes txt = ann.getNestedDataset(Tag.TextObjectSequence);
        assertEquals("%DS 52.3", txt.getString(Tag.UnformattedTextValue));
        assertEquals(30.5f, txt.getFloats(Tag.AnchorPoint)[0], 1e-6);
    }

    @Test
    void graphicLayerIsDeclared() {
        // GraphicAnnotation があるのに GraphicLayer が無いと非準拠。
        var r = XaPresentationStateWriter.build(xaTemplate(), req(null, null), 512, 512);
        Attributes layer = r.dataset().getNestedDataset(Tag.GraphicLayerSequence);
        assertEquals("QCA", layer.getString(Tag.GraphicLayer));
        assertEquals(1, layer.getInt(Tag.GraphicLayerOrder, 0));
    }

    @Test
    void contentLabelIsValidCs() {
        // ContentLabel は Type 1 かつ CS（大文字・空白不可）。
        assertEquals("QCA_RUN_1", XaPresentationStateWriter.toContentLabel("QCA run 1"));
        assertEquals("GRAPHY_PR", XaPresentationStateWriter.toContentLabel(null));
        assertEquals("GRAPHY_PR", XaPresentationStateWriter.toContentLabel("   "));
        assertEquals(16, XaPresentationStateWriter.toContentLabel("A".repeat(40)).length());
        String label = XaPresentationStateWriter
                .build(xaTemplate(), req(null, null), 512, 512).dataset().getString(Tag.ContentLabel);
        assertFalse(label.contains(" "));
        assertTrue(label.length() <= 16);
    }

    @Test
    void invalidRotationFallsBackToZero() {
        var base = req(null, null);
        var odd = new AngioPresentationRequest(
                base.studyInstanceUid(), base.seriesInstanceUid(), base.sopInstanceUid(), base.frameNumbers(),
                base.label(), base.description(), base.creator(), base.voi(), false, 45, false,
                null, null, List.of(), List.of());
        var r = XaPresentationStateWriter.build(xaTemplate(), odd, 512, 512);
        assertEquals(0, r.dataset().getInt(Tag.ImageRotation, -1));
        assertEquals("IDENTITY", r.dataset().getString(Tag.PresentationLUTShape));
    }

    private static void assertArrayEqualsInt(int[] expected, int[] actual) {
        assertNotNull(actual);
        assertEquals(expected.length, actual.length);
        for (int i = 0; i < expected.length; i++) {
            assertEquals(expected[i], actual[i]);
        }
    }
}

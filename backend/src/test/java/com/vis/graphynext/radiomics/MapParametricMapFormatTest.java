/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import static org.junit.jupiter.api.Assertions.*;

import com.vis.graphynext.dicom.ParametricMapFrameExpander;
import com.vis.graphynext.dicom.SeriesLayout;
import com.vis.graphynext.microscopy.ConfocalMicroscopyWriter;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.List;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.junit.jupiter.api.Test;

/**
 * マップ・フィルタ済みシリーズの書き出し（Parametric Map・16 bit 符号なし整数＋RWVM）の形と、読み戻し。
 * 値は 32768 以上の画素を含み、NaN・Inf は画素 0（値なし）→ 読み手は NaN を返す。
 */
class MapParametricMapFormatTest {

    static final int W = 16, H = 12;
    static final ConfocalMicroscopyWriter.Equipment EQ =
            new ConfocalMicroscopyWriter.Equipment("Visionary Imaging Services, Inc.", "GRAPHY-Next", "serial-uuid", "9.9.9");

    /** 0〜約 65 の ramp。i==3 が NaN、i==4 が +Inf、i==5 が −Inf。 */
    static float[] data() {
        float[] d = new float[W * H];
        for (int i = 0; i < d.length; i++) d[i] = i * 0.37f - 5f;
        d[3] = Float.NaN;
        d[4] = Float.POSITIVE_INFINITY;
        d[5] = Float.NEGATIVE_INFINITY;
        return d;
    }

    static Attributes tmpl(String modality) {
        Attributes t = new Attributes();
        t.setString(Tag.SOPClassUID, VR.UI, UID.CTImageStorage);
        t.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3.4.1");
        t.setString(Tag.SeriesInstanceUID, VR.UI, "1.2.3.4");
        t.setString(Tag.Modality, VR.CS, modality);
        t.setString(Tag.PatientID, VR.LO, "P1");
        t.setString(Tag.PatientName, VR.PN, "Test^Patient");
        t.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        t.setString(Tag.StudyDate, VR.DA, "20260101");
        // Study Time・Referring Physician・Study ID・Accession・Birth date・Sex は元が空（Type 2 は空で書かれるはず）
        t.setNull(Tag.StudyTime, VR.TM);
        t.setNull(Tag.StudyID, VR.SH);
        t.setNull(Tag.AccessionNumber, VR.SH);
        t.setNull(Tag.PatientSex, VR.CS);
        t.setString(Tag.Manufacturer, VR.LO, "SOURCE-MAKER");
        t.setString(Tag.Units, VR.CS, "BQML");
        return t;
    }

    static Attributes build(Attributes tmpl, float[] d, String kind, boolean lossy) {
        double[] q = TextureSeriesService.quantization(TextureSeriesService.minMax(new float[][] { d }));
        byte[] px = TextureSeriesService.to16bit(d, q[2], q[3]);
        RadiomicsMapEngine.MapResult map = new RadiomicsMapEngine.MapResult(W, H, 1, new float[][] { d },
                "GLCM_JointEntropy", new double[] { 1, 0, 0, 0, 1, 0 }, 0.8, 0.9,
                List.of(new double[] { 1, 2, 3 }), List.of("1.2.3.4.1"), "1.2.3.9", lossy);
        return TextureSeriesService.buildInstance(tmpl, "1.2.3", map, "1.2.3.5", 2001, "desc", kind,
                "GLCM_JointEntropy", "Texture map GLCM_JointEntropy (test)", q[2], q[3], q[0] + (q[1] - q[0]) / 2,
                q[1] - q[0], 2.0, 2.0, 0, px, EQ);
    }

    static Attributes roundTrip(Attributes a) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (DicomOutputStream dos = new DicomOutputStream(bos, UID.ExplicitVRLittleEndian)) {
            dos.writeDataset(a.createFileMetaInformation(UID.ExplicitVRLittleEndian), a);
        }
        try (DicomInputStream in = new DicomInputStream(new ByteArrayInputStream(bos.toByteArray()))) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
            return in.readDataset();
        }
    }

    @Test
    void writesTheRequiredAttributesOfAnIntegerParametricMap() throws Exception {
        Attributes a = roundTrip(build(tmpl("PT"), data(), "TEXTURE", false));
        assertEquals(UID.ParametricMapStorage, a.getString(Tag.SOPClassUID));
        assertEquals("PT", a.getString(Tag.Modality), "Modality は元を保つ");
        assertArrayEquals(new String[] {"DERIVED", "PRIMARY", "TEXTURE", "FILTERED"}, a.getStrings(Tag.ImageType));
        assertEquals(16, a.getInt(Tag.BitsAllocated, 0));
        assertEquals(16, a.getInt(Tag.BitsStored, 0));
        assertEquals(15, a.getInt(Tag.HighBit, 0));
        assertEquals(0, a.getInt(Tag.PixelRepresentation, -1));
        assertEquals(1, a.getInt(Tag.NumberOfFrames, 0));
        // トップレベルの Rescale・Window は PM では禁止（Modality LUT・VOI LUT モジュール）
        for (int t : new int[] { Tag.RescaleSlope, Tag.RescaleIntercept, Tag.RescaleType, Tag.WindowCenter,
                Tag.WindowWidth, Tag.DerivationDescription, Tag.SourceImageSequence, Tag.ImagePositionPatient,
                Tag.ImageOrientationPatient, Tag.PixelSpacing }) {
            assertFalse(a.contains(t), "top-level " + org.dcm4che3.util.TagUtils.toString(t));
        }
        assertEquals("TEXTURE_MAP", a.getString(Tag.ContentLabel));
        assertEquals("RESEARCH", a.getString(Tag.ContentQualification));
        assertEquals("IDENTITY", a.getString(Tag.PresentationLUTShape));
        assertEquals("NO", a.getString(Tag.BurnedInAnnotation));
        assertEquals("YES", a.getString(Tag.RecognizableVisualFeatures));
        assertEquals("00", a.getString(Tag.LossyImageCompression));
        // 装置（Enhanced General Equipment は 4 つとも Type 1）。元の装置は引き継がない
        assertEquals("Visionary Imaging Services, Inc.", a.getString(Tag.Manufacturer));
        assertEquals("GRAPHY-Next", a.getString(Tag.ManufacturerModelName));
        assertEquals("serial-uuid", a.getString(Tag.DeviceSerialNumber));
        assertEquals("9.9.9", a.getString(Tag.SoftwareVersions));
        // Type 2 は元が空でも属性を書く
        for (int t : new int[] { Tag.StudyTime, Tag.StudyID, Tag.AccessionNumber, Tag.PatientSex,
                Tag.ReferringPhysicianName, Tag.PatientBirthDate, Tag.PositionReferenceIndicator }) {
            assertTrue(a.contains(t), "Type 2 " + org.dcm4che3.util.TagUtils.toString(t));
        }
        assertTrue(a.contains(Tag.AcquisitionContextSequence));
        assertEquals(0, a.getSequence(Tag.AcquisitionContextSequence).size());
        assertNotNull(a.getString(Tag.ContentDate));
        assertNotNull(a.getString(Tag.ContentTime));
        assertEquals("1.2.3.9", a.getString(Tag.FrameOfReferenceUID));
        // 機能グループ
        Attributes sh = PmReadSupport.shared(a);
        Attributes pvt = sh.getNestedDataset(Tag.PixelValueTransformationSequence);
        assertEquals(1.0, pvt.getDouble(Tag.RescaleSlope, 0));
        assertEquals(0.0, pvt.getDouble(Tag.RescaleIntercept, 1));
        assertEquals("US", pvt.getString(Tag.RescaleType));
        assertNotNull(sh.getNestedDataset(Tag.ParametricMapFrameTypeSequence));
        assertArrayEquals(a.getStrings(Tag.ImageType),
                sh.getNestedDataset(Tag.ParametricMapFrameTypeSequence).getStrings(Tag.FrameType));
        Attributes rw = PmReadSupport.rwvm(a);
        assertEquals(1, rw.getInt(Tag.RealWorldValueFirstValueMapped, -1));
        assertEquals(65535, rw.getInt(Tag.RealWorldValueLastValueMapped, -1));
        assertFalse(rw.contains(Tag.DoubleFloatRealWorldValueFirstValueMapped));
        assertTrue(rw.getString(Tag.LUTLabel).length() <= 16);
        assertEquals("1", rw.getNestedDataset(Tag.MeasurementUnitsCodeSequence).getString(Tag.CodeValue));
        assertEquals("UCUM", rw.getNestedDataset(Tag.MeasurementUnitsCodeSequence).getString(Tag.CodingSchemeDesignator));
        Attributes pf = PmReadSupport.perFrame(a);
        assertNotNull(pf.getNestedDataset(Tag.PlanePositionSequence));
        assertArrayEquals(new int[] { 1 }, pf.getNestedDataset(Tag.FrameContentSequence).getInts(Tag.DimensionIndexValues));
        Attributes der = PmReadSupport.derivation(a);
        Attributes code = der.getNestedDataset(Tag.DerivationCodeSequence);
        assertEquals("TEXTURE_MAP", code.getString(Tag.CodeValue));
        assertEquals("99GRAPHYNEXT", code.getString(Tag.CodingSchemeDesignator));
        Attributes src = der.getSequence(Tag.SourceImageSequence).get(0);
        assertEquals("1.2.3.4.1", src.getString(Tag.ReferencedSOPInstanceUID));
        assertEquals("121322", src.getNestedDataset(Tag.PurposeOfReferenceCodeSequence).getString(Tag.CodeValue));
        Sequence ref = a.getSequence(Tag.ReferencedSeriesSequence);
        assertEquals("1.2.3.4", ref.get(0).getString(Tag.SeriesInstanceUID));
        assertEquals("1.2.3.4.1", ref.get(0).getSequence(Tag.ReferencedInstanceSequence).get(0).getString(Tag.ReferencedSOPInstanceUID));
        // Dimension
        assertEquals(1, a.getSequence(Tag.DimensionIndexSequence).size());
        // 元の PET の属性（Units など）は持ち込まない（SUV 校正の根拠にしない）
        assertFalse(a.contains(Tag.Units));
    }

    @Test
    void lossySourceIsRecordedAndLogUsesItsOwnCode() throws Exception {
        Attributes a = roundTrip(build(tmpl("CT"), data(), "LOG", true));
        assertEquals("01", a.getString(Tag.LossyImageCompression));
        assertEquals("LOG_FILTER", a.getString(Tag.ContentLabel));
        assertArrayEquals(new String[] {"DERIVED", "PRIMARY", "LOG", "FILTERED"}, a.getStrings(Tag.ImageType));
        assertEquals("Laplacian of Gaussian filter",
                PmReadSupport.derivation(a).getNestedDataset(Tag.DerivationCodeSequence).getString(Tag.CodeMeaning));
    }

    @Test
    void roundTripGivesRealValuesWithinHalfAStepAndNoValueForNonFinite() throws Exception {
        float[] d = data();
        Attributes a = roundTrip(build(tmpl("CT"), d, "TEXTURE", false));
        double slope = PmReadSupport.slope(a);
        float[] got = PmReadSupport.decode(a);
        float[] viaReader = ParametricMapFrameExpander.frameValues(a, 0);
        assertNotNull(viaReader);
        int high = 0;
        for (int i = 0; i < d.length; i++) {
            if (Float.isFinite(d[i])) {
                assertEquals(d[i], got[i], slope / 2 + 1e-6, "i=" + i);
                assertEquals(d[i], viaReader[i], slope / 2 + 1e-6, "reader i=" + i);
            } else {
                assertTrue(Float.isNaN(got[i]) && Float.isNaN(viaReader[i]), "no value i=" + i);
            }
            // 32768 以上の画素を含むこと（旧形式で化けた範囲）
            int sv = (int) Math.round((d[i] - PmReadSupport.intercept(a)) / slope);
            if (Float.isFinite(d[i]) && sv >= 32768) high++;
        }
        assertTrue(high > 10, "32768 以上の画素を含む: " + high);
        // 最小は画素 1、最大は 65535（0 は値なしに空ける）
        byte[] px = a.getBytes(Tag.PixelData);
        int min = 65536, max = -1;
        for (int i = 0; i < px.length; i += 2) {
            int v = (px[i] & 0xFF) | ((px[i + 1] & 0xFF) << 8);
            if (v == 0) continue;
            min = Math.min(min, v);
            max = Math.max(max, v);
        }
        assertEquals(1, min);
        assertEquals(65535, max);
    }

    @Test
    void theViewerPathReadsAnIntegerMapAsRealValues() throws Exception {
        float[] d = data();
        Attributes a = roundTrip(build(tmpl("PT"), d, "TEXTURE", false));
        SeriesLayout layout = ParametricMapFrameExpander.layout(List.of(a));
        assertNotNull(layout);
        assertEquals(1, layout.nZ());
        byte[] one = ParametricMapFrameExpander.extractFrame(a, 0);
        assertNotNull(one, "整数 PM のフレームを切り出せる");
        try (DicomInputStream in = new DicomInputStream(new ByteArrayInputStream(one))) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
            Attributes sc = in.readDataset();
            float[] v = ParametricMapFrameExpander.frameValues(sc, 0);
            assertEquals(d[10], v[10], PmReadSupport.slope(a) / 2 + 1e-6);
            assertTrue(Float.isNaN(v[3]), "値なしは NaN のまま");
        }
        assertNotNull(ParametricMapFrameExpander.blankFrame(a, new double[] { 0, 0, 0 }));
    }

    @Test
    void refusesWhenAnyOfOrientationFrameOfReferenceOrPositionIsMissing() {
        float[] d = data();
        byte[] px = new byte[W * H * 2];
        double[] iop = { 1, 0, 0, 0, 1, 0 };
        List<double[]> ipp = List.of(new double[] { 0, 0, 0 });
        var noIpp = new RadiomicsMapEngine.MapResult(W, H, 1, new float[][] { d }, "f", iop, 1, 1,
                java.util.Collections.singletonList((double[]) null), List.of("1"), "1.2.3.9", false);
        var noFor = new RadiomicsMapEngine.MapResult(W, H, 1, new float[][] { d }, "f", iop, 1, 1, ipp, List.of("1"), null, false);
        var noIop = new RadiomicsMapEngine.MapResult(W, H, 1, new float[][] { d }, "f", null, 1, 1, ipp, List.of("1"), "1.2.3.9", false);
        for (var m : List.of(noIpp, noFor, noIop)) {
            IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                    () -> TextureSeriesService.buildInstance(tmpl("CT"), "1.2.3", m, "1.2.3.5", 1, "d", "TEXTURE", "f", "x",
                            1, 0, 0, 1, 1, 1, 0, px, EQ));
            assertTrue(e.getMessage().contains("Parametric Map にできません"), e.getMessage());
        }
        // 正例: 全部揃えば書ける
        assertEquals(UID.ParametricMapStorage, build(tmpl("CT"), d, "TEXTURE", false).getString(Tag.SOPClassUID));
    }

    /** 値が 1 つも無いフレーム（ROI の無いスライス）の表示用の窓は、有限（RWVM の値の範囲）でなければならない。 */
    @Test
    void anAllNoValueFrameStillGetsAFiniteWindow() throws Exception {
        float[] none = new float[W * H];
        java.util.Arrays.fill(none, Float.NaN);
        Attributes a = roundTrip(build(tmpl("PT"), none, "TEXTURE", false));
        double[] expect = ParametricMapFrameExpander.mappedRange(PmReadSupport.rwvm(a));
        assertTrue(expect[0] < expect[1], "RWVM の値の範囲がある");

        for (byte[] frame : new byte[][] { ParametricMapFrameExpander.extractFrame(a, 0),
                ParametricMapFrameExpander.blankFrame(a, new double[] { 0, 0, 0 }) }) {
            assertNotNull(frame);
            try (DicomInputStream in = new DicomInputStream(new ByteArrayInputStream(frame))) {
                in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
                Attributes sc = in.readDataset();
                double wc = sc.getDouble(Tag.WindowCenter, Double.NaN);
                double ww = sc.getDouble(Tag.WindowWidth, Double.NaN);
                assertTrue(Double.isFinite(wc) && Double.isFinite(ww) && ww > 0, "窓が有限: " + wc + "/" + ww);
                assertEquals((expect[0] + expect[1]) / 2, wc, 1e-6 * Math.max(1, Math.abs(wc)));
                assertEquals(expect[1] - expect[0], ww, 1e-6 * Math.max(1, ww));
                float[] v = ParametricMapFrameExpander.frameValues(sc, 0);
                for (float f : v) assertTrue(Float.isNaN(f), "画素は値なしのまま");
            }
        }
    }

    /** 【負例】値があるフレームの窓は、従来どおりそのフレームの最小・最大（RWVM の範囲に置き換わらない）。 */
    @Test
    void aFrameWithValuesKeepsItsOwnWindow() throws Exception {
        float[] d = data();
        Attributes a = roundTrip(build(tmpl("PT"), d, "TEXTURE", false));
        byte[] frame = ParametricMapFrameExpander.extractFrame(a, 0);
        try (DicomInputStream in = new DicomInputStream(new ByteArrayInputStream(frame))) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.YES);
            Attributes sc = in.readDataset();
            float[] v = ParametricMapFrameExpander.frameValues(sc, 0);
            double min = Double.POSITIVE_INFINITY, max = Double.NEGATIVE_INFINITY;
            for (float f : v) if (Float.isFinite(f)) { min = Math.min(min, f); max = Math.max(max, f); }
            assertEquals((min + max) / 2, sc.getDouble(Tag.WindowCenter, Double.NaN), 1e-4);
            assertEquals(max - min, sc.getDouble(Tag.WindowWidth, Double.NaN), 1e-4);
        }
    }
}

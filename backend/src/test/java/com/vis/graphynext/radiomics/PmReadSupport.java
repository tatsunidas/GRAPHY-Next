/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** 試験用: マップ・フィルタ済みシリーズ（Parametric Map・整数画素）の機能グループと実値の読み取り。 */
final class PmReadSupport {

    private PmReadSupport() {
    }

    static Attributes shared(Attributes a) {
        return a.getNestedDataset(Tag.SharedFunctionalGroupsSequence);
    }

    static Attributes perFrame(Attributes a) {
        return a.getNestedDataset(Tag.PerFrameFunctionalGroupsSequence);
    }

    static double[] ipp(Attributes a) {
        return perFrame(a).getNestedDataset(Tag.PlanePositionSequence).getDoubles(Tag.ImagePositionPatient);
    }

    static double[] iop(Attributes a) {
        return shared(a).getNestedDataset(Tag.PlaneOrientationSequence).getDoubles(Tag.ImageOrientationPatient);
    }

    static double[] pixelSpacing(Attributes a) {
        return shared(a).getNestedDataset(Tag.PixelMeasuresSequence).getDoubles(Tag.PixelSpacing);
    }

    static Attributes derivation(Attributes a) {
        return perFrame(a).getNestedDataset(Tag.DerivationImageSequence);
    }

    static String derivationDescription(Attributes a) {
        return derivation(a).getString(Tag.DerivationDescription);
    }

    static Attributes rwvm(Attributes a) {
        return shared(a).getNestedDataset(Tag.RealWorldValueMappingSequence);
    }

    static double slope(Attributes a) {
        return rwvm(a).getDouble(Tag.RealWorldValueSlope, Double.NaN);
    }

    static double intercept(Attributes a) {
        return rwvm(a).getDouble(Tag.RealWorldValueIntercept, Double.NaN);
    }

    /** 特徴名（LUT Explanation）。 */
    static String featureName(Attributes a) {
        return rwvm(a).getString(Tag.LUTExplanation);
    }

    /** 初期の窓（保存値の領域）{center, width}。 */
    static double[] storedWindow(Attributes a) {
        Attributes v = shared(a).getNestedDataset(Tag.FrameVOILUTSequence);
        return new double[] { v.getDouble(Tag.WindowCenter, Double.NaN), v.getDouble(Tag.WindowWidth, Double.NaN) };
    }

    /** 実値に直した窓 {center, width}。 */
    static double[] realWindow(Attributes a) {
        double[] w = storedWindow(a);
        return new double[] { w[0] * slope(a) + intercept(a), w[1] * slope(a) };
    }

    /** 規格どおりの読み方: 範囲の外（画素 0＝値なし）は NaN、ほかは 傾き×画素＋切片。 */
    static float[] decode(Attributes a) throws java.io.IOException {
        byte[] px = a.getBytes(Tag.PixelData);
        ByteBuffer bb = ByteBuffer.wrap(px).order(ByteOrder.LITTLE_ENDIAN);
        Attributes m = rwvm(a);
        double slope = m.getDouble(Tag.RealWorldValueSlope, 1), intercept = m.getDouble(Tag.RealWorldValueIntercept, 0);
        int first = m.getInt(Tag.RealWorldValueFirstValueMapped, 0), last = m.getInt(Tag.RealWorldValueLastValueMapped, 65535);
        float[] v = new float[px.length / 2];
        for (int i = 0; i < v.length; i++) {
            int sv = bb.getShort() & 0xFFFF;
            v[i] = sv < first || sv > last ? Float.NaN : (float) (sv * slope + intercept);
        }
        return v;
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;

/**
 * Confocal Microscopy Image（CFM）のフレームの幾何を、表示用の仮の患者座標に写す（fw/microscopy-cfm.md）。
 *
 * <p>CFM のフレームの位置は Plane Position (Slide)（スライド座標）で、患者座標（Plane Position (Patient)）を持たない。
 * 本体の 2D・3D・MPR は患者座標が前提なので、スライドの X・Y・Z をそのまま患者の x・y・z とみなす。
 * <b>オフセットの単位は X・Y が mm、Z が µm</b>（PS3.3 C.8.12.2）なので、Z は 1/1000 して mm に直す。
 * 向きは {@code ImageOrientationSlide} があればそれ、無ければ (1,0,0,0,1,0)。保存されたファイルの属性は変えない。
 */
public final class ConfocalGeometry {

    /** 切り出したフレームに足す注記（表示用に写したことを、後から見た人が分かるように）。 */
    public static final String DISPLAY_NOTE = "Slide coordinates mapped to patient axes for display (not patient coordinates)";

    private ConfocalGeometry() {
    }

    public static boolean isConfocal(Attributes ds) {
        return ds != null && UID.ConfocalMicroscopyImageStorage.equals(ds.getString(Tag.SOPClassUID));
    }

    /** フレームの位置（mm）。CFM はスライド座標から、ほかは Plane Position (Patient) から。無ければ null。 */
    public static double[] framePosition(Attributes ds, int frame) {
        if (!isConfocal(ds)) {
            return SegFrameExpander.perFrameIpp(ds, frame);
        }
        Attributes slide = slideItem(ds, frame);
        if (slide == null) {
            return null;
        }
        double x = slide.getDouble(Tag.XOffsetInSlideCoordinateSystem, Double.NaN);
        double y = slide.getDouble(Tag.YOffsetInSlideCoordinateSystem, Double.NaN);
        double zUm = slide.getDouble(Tag.ZOffsetInSlideCoordinateSystem, Double.NaN);
        if (Double.isNaN(x) || Double.isNaN(y) || Double.isNaN(zUm)) {
            return null;
        }
        return new double[] { x, y, zUm / 1000.0 };
    }

    /** 向き。CFM は ImageOrientationSlide、無ければ (1,0,0,0,1,0)。ほかは共有の Plane Orientation。 */
    public static double[] orientation(Attributes ds) {
        if (!isConfocal(ds)) {
            return SegFrameExpander.sharedIop(ds);
        }
        double[] o = ds.getDoubles(Tag.ImageOrientationSlide);
        return o != null && o.length == 6 ? o : new double[] { 1, 0, 0, 0, 1, 0 };
    }

    /** そのフレームの Plane Position (Slide)（フレームごと → 共有の順）。 */
    private static Attributes slideItem(Attributes ds, int frame) {
        org.dcm4che3.data.Sequence pf = ds.getSequence(Tag.PerFrameFunctionalGroupsSequence);
        if (pf != null && frame >= 0 && frame < pf.size()) {
            Attributes it = pf.get(frame).getNestedDataset(Tag.PlanePositionSlideSequence);
            if (it != null) {
                return it;
            }
        }
        Attributes shared = ds.getNestedDataset(Tag.SharedFunctionalGroupsSequence);
        return shared == null ? null : shared.getNestedDataset(Tag.PlanePositionSlideSequence);
    }
}

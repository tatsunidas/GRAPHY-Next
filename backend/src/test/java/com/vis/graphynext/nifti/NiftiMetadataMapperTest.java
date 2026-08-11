/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.junit.jupiter.api.Test;

/** サイドカー JSON（dcm2niix / BIDS）→ DICOM 属性の写し。 */
class NiftiMetadataMapperTest {

    @Test
    void キーワードが一致する項目を写す() {
        Attributes ds = new Attributes();
        int applied = NiftiMetadataMapper.apply(ds, Map.of(
                "Manufacturer", "SIEMENS",
                "MagneticFieldStrength", 3,
                "FlipAngle", 12.5,
                "SeriesDescription", "cine SAX"));
        assertThat(applied).isEqualTo(4);
        assertThat(ds.getString(Tag.Manufacturer)).isEqualTo("SIEMENS");
        assertThat(ds.getDouble(Tag.MagneticFieldStrength, 0)).isEqualTo(3.0);
        assertThat(ds.getDouble(Tag.FlipAngle, 0)).isEqualTo(12.5);
        assertThat(ds.getString(Tag.SeriesDescription)).isEqualTo("cine SAX");
    }

    @Test
    void 時間系は秒からミリ秒へ直す() {
        // BIDS は秒、DICOM は ms。ここを取り違えると TR が 1000 倍ずれる。
        Attributes ds = new Attributes();
        NiftiMetadataMapper.apply(ds, Map.of(
                "RepetitionTime", 0.04,
                "EchoTime", 0.0016,
                "InversionTime", 0.3));
        assertThat(ds.getDouble(Tag.RepetitionTime, 0)).isEqualTo(40.0);
        assertThat(ds.getDouble(Tag.EchoTime, 0)).isEqualTo(1.6);
        assertThat(ds.getDouble(Tag.InversionTime, 0)).isEqualTo(300.0);
    }

    @Test
    void 一文字違いのキーも拾う() {
        // dcm2niix は "ManufacturersModelName"（DICOM は ManufacturerModelName）を出す
        assertThat(NiftiMetadataMapper.findTag("ManufacturersModelName"))
                .isEqualTo(Tag.ManufacturerModelName);
        assertThat(NiftiMetadataMapper.findTag("manufacturer_model_name"))
                .isEqualTo(Tag.ManufacturerModelName);
    }

    @Test
    void 変換側が決めるタグは上書きさせない() {
        Attributes ds = new Attributes();
        ds.setDouble(Tag.PixelSpacing, org.dcm4che3.data.VR.DS, 1.0, 1.0);
        NiftiMetadataMapper.apply(ds, Map.of(
                "PixelSpacing", List.of(9.9, 9.9),
                "Rows", 999,
                "SOPInstanceUID", "1.2.3",
                "ImageOrientationPatient", List.of(0, 0, 1, 0, 1, 0)));
        assertThat(ds.getDoubles(Tag.PixelSpacing)).containsExactly(1.0, 1.0);
        assertThat(ds.getString(Tag.SOPInstanceUID)).isNull();
        assertThat(ds.getInt(Tag.Rows, -1)).isEqualTo(-1);
    }

    @Test
    void 知らないキーは黙って無視する() {
        Attributes ds = new Attributes();
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("BidsVersionOfSomething", "x");
        meta.put("Manufacturer", "GE");
        assertThat(NiftiMetadataMapper.apply(ds, meta)).isEqualTo(1);
        assertThat(ds.getString(Tag.Manufacturer)).isEqualTo("GE");
    }

    @Test
    void 数値_VR_に非数値が来たら入れない() {
        Attributes ds = new Attributes();
        NiftiMetadataMapper.apply(ds, Map.of("FlipAngle", "n/a"));
        assertThat(ds.contains(Tag.FlipAngle)).isFalse();
    }

    @Test
    void 配列は複数値として入る() {
        Attributes ds = new Attributes();
        NiftiMetadataMapper.apply(ds, Map.of("ImageType", List.of("ORIGINAL", "PRIMARY", "M")));
        assertThat(ds.getStrings(Tag.ImageType)).containsExactly("ORIGINAL", "PRIMARY", "M");
    }

    @Test
    void null_は無視する() {
        Attributes ds = new Attributes();
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("Manufacturer", null);
        assertThat(NiftiMetadataMapper.apply(ds, meta)).isZero();
    }
}

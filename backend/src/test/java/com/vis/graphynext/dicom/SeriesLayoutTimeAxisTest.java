/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.data.Offset.offset;

/**
 * web 経路（{@link SeriesLayoutAssembler#fromAttributes}）が、ヘッダから時間軸を付けること。
 * standalone の {@code DicomStorageService.seriesLayout} は同じ {@link LayoutTimeAxis} を呼ぶ
 * （実起動の確認は automator のスパイク）。**片方だけ直して食い違う**事故を、web 側で固定する。
 */
class SeriesLayoutTimeAxisTest {

    private static Attributes inst(int z, int t, String acqTime, Double triggerMs) {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPInstanceUID, VR.UI, "1.2.3." + z + "." + t);
        ds.setInt(Tag.InstanceNumber, VR.IS, t * 10 + z + 1);
        ds.setDouble(Tag.ImagePositionPatient, VR.DS, 0, 0, z * 5.0);
        ds.setDouble(Tag.ImageOrientationPatient, VR.DS, 1, 0, 0, 0, 1, 0);
        ds.setInt(Tag.TemporalPositionIdentifier, VR.IS, t + 1);
        if (acqTime != null) {
            ds.setString(Tag.AcquisitionDate, VR.DA, "20261020");
            ds.setString(Tag.AcquisitionTime, VR.TM, acqTime);
        }
        if (triggerMs != null) {
            ds.setDouble(Tag.TriggerTime, VR.DS, triggerMs);
        }
        return ds;
    }

    @Test
    void assemblerAttachesTheTimeAxisFromAcquisitionTime() {
        List<Attributes> list = new ArrayList<>();
        for (int t = 0; t < 4; t++) {
            for (int z = 0; z < 2; z++) {
                // 時相間 6 s、スライスごとに 0.5 s 遅れ。
                double sec = 36000 + 6.0 * t + 0.5 * z;
                list.add(inst(z, t, String.format("%02d%02d%06.3f", (int) sec / 3600, ((int) sec % 3600) / 60, sec % 60), null));
            }
        }
        SeriesLayout l = SeriesLayoutAssembler.fromAttributes(list);
        assertThat(l.nT()).isEqualTo(4);
        assertThat(l.timeAxis()).isNotNull();
        assertThat(l.timeAxis().source()).isEqualTo("AcquisitionTime");
        for (SeriesLayout.Cell c : l.cells()) {
            assertThat(l.timeAxis().secBySop().get(c.sopInstanceUid())).isCloseTo(6.0 * c.t() + 0.5 * c.z(), offset(1e-3));
        }
    }

    @Test
    void assemblerFallsBackToTriggerTimeAndLeavesStaticVolumesWithoutATimeAxis() {
        List<Attributes> dyn = new ArrayList<>();
        for (int t = 0; t < 3; t++) {
            dyn.add(inst(0, t, null, 2500.0 * t));
        }
        SeriesLayout l = SeriesLayoutAssembler.fromAttributes(dyn);
        assertThat(l.timeAxis()).isNotNull();
        assertThat(l.timeAxis().source()).isEqualTo("TriggerTime");

        List<Attributes> vol = new ArrayList<>(); // 時相 1 の 3D
        for (int z = 0; z < 3; z++) {
            vol.add(inst(z, 0, "100000", null));
        }
        assertThat(SeriesLayoutAssembler.fromAttributes(vol).timeAxis()).isNull();

        // 時刻のタグが全く無い 4D も null（順序だけ。秒を作り出さない）
        List<Attributes> noTime = new ArrayList<>();
        for (int t = 0; t < 3; t++) {
            noTime.add(inst(0, t, null, null));
        }
        assertThat(SeriesLayoutAssembler.fromAttributes(noTime).timeAxis()).isNull();
    }
}

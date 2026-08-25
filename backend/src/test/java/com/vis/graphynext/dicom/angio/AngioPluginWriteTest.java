/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.angio;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * プラグイン経路（H37 / H38）で作った SR・GSPS が、<b>本体経路と同じ writer を通り、
 * かつ出所が刻まれている</b>ことを見る。
 *
 * <p>ここが崩れると「プラグインが出した SR だけ構造が違う」または
 * 「誰が計算したか分からない DICOM が保管庫に増える」のどちらかになる。
 */
class AngioPluginWriteTest {

    private static final AngioPluginSrRequest.Producer P =
            new AngioPluginSrRequest.Producer("angio-quant", "Angio Quant", "0.1.0");

    private static Attributes template() {
        Attributes ds = new Attributes();
        ds.setString(Tag.SOPClassUID, VR.UI, UID.XRayAngiographicImageStorage);
        ds.setString(Tag.StudyInstanceUID, VR.UI, "1.2.3");
        ds.setString(Tag.PatientID, VR.LO, "P001");
        ds.setInt(Tag.Rows, VR.US, 512);
        ds.setInt(Tag.Columns, VR.US, 512);
        return ds;
    }

    @Test
    void qcaSrKeepsBodyStructureAndGainsProvenance() {
        QcaSrRequest req = new QcaSrRequest("1.2.3", "1.2.3.9", "1.2.3.10", 12, "mm",
                "カテーテル 6Fr / 0.208 mm/px", "LAD proximal", null, "densitometric",
                1.47, 3.00, 51.0, 76.0, 6.2);

        // 本体経路（出所なし）とプラグイン経路（出所あり）を同じ writer で作る。
        Attributes body = QcaSrWriter.build(template(), req).dataset();
        Attributes plugin = QcaSrWriter.build(template(), req).dataset();
        AngioSrProvenance.stamp(plugin, P);

        // 構造は同じ（内容ツリーの項目数が変わらない）。
        assertEquals(body.getSequence(Tag.ContentSequence).size(),
                plugin.getSequence(Tag.ContentSequence).size(), "内容ツリーは同じ");
        assertEquals(body.getString(Tag.SOPClassUID), plugin.getString(Tag.SOPClassUID));

        // 違うのは出所だけ。
        assertEquals("QCA", body.getString(Tag.SeriesDescription));
        assertEquals("[Plugin] QCA", plugin.getString(Tag.SeriesDescription));
        assertNotNull(plugin.getNestedDataset(Tag.ContributingEquipmentSequence));
        assertTrue(body.getSequence(Tag.ContributingEquipmentSequence) == null,
                "本体経路には出所を付けない（付けると『本体が書いた』の意味が薄れる）");
    }

    @Test
    void presentationStateGainsProvenanceAndStaysXaGsps() {
        AngioPresentationRequest ps = new AngioPresentationRequest(
                "1.2.3", "1.2.3.9", "1.2.3.10", List.of(1, 2, 3), "PLUGIN", "desc", "plugin",
                new AngioPresentationRequest.Voi(0.1, 0.5), Boolean.FALSE, 0, Boolean.FALSE,
                new AngioPresentationRequest.Mask(List.of(1), 0.5, -0.25, "AVG_SUB"),
                new AngioPresentationRequest.Calibration(0.21, 0.21, "FIDUCIAL", "6Fr catheter"),
                List.of(), List.of());

        Attributes ds = XaPresentationStateWriter.build(template(), ps, 512, 512).dataset();
        AngioSrProvenance.stamp(ds, P);

        // XA/XRF GSPS（11.5）のままであること——DSA のマスクを保存できるのはこれだけ。
        assertEquals(UID.XAXRFGrayscaleSoftcopyPresentationStateStorage, ds.getString(Tag.SOPClassUID));
        assertTrue(ds.getString(Tag.SeriesDescription).startsWith("[Plugin] "));
        Attributes eq = ds.getNestedDataset(Tag.ContributingEquipmentSequence);
        assertNotNull(eq);
        assertEquals("Angio Quant", eq.getString(Tag.ManufacturerModelName));
    }
}

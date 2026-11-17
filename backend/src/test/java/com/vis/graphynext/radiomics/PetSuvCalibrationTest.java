/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SUV の係数。式の基準は、別に書いた Python の参照（{@code automator/src/spike/suvGoldenReference.py}）が作る共通のテスト値
 * （{@code suv-golden.json}。フロントの {@code suv.ts} も同じ値で検査する）。
 */
class PetSuvCalibrationTest {

    private static Double dbl(JsonNode n, String k) {
        return n.hasNonNull(k) ? n.get(k).asDouble() : null;
    }

    private static PetSuvCalibration.Params paramsOf(JsonNode p) {
        return new PetSuvCalibration.Params(
                dbl(p, "patientWeight"), dbl(p, "patientHeight"), p.hasNonNull("patientSex") ? p.get("patientSex").asText() : null,
                dbl(p, "totalDoseBq"), dbl(p, "halfLifeSec"), "test",
                p.hasNonNull("injectionTimeMs") ? p.get("injectionTimeMs").asLong() : null,
                p.hasNonNull("scanTimeMs") ? p.get("scanTimeMs").asLong() : null,
                p.hasNonNull("units") ? p.get("units").asText() : null, List.of(),
                p.hasNonNull("decayCorrection") ? p.get("decayCorrection").asText() : null,
                dbl(p, "philipsSuvScaleFactor"), dbl(p, "philipsActivityConcScaleFactor"),
                p.path("alreadySuv").asBoolean(false), "PT");
    }

    @Test
    void matchesTheGoldenValuesOfTheIndependentReference() throws Exception {
        JsonNode root;
        try (InputStream in = getClass().getResourceAsStream("/radiomics/suv-golden.json")) {
            assertNotNull(in, "suv-golden.json がありません");
            root = new ObjectMapper().readTree(in);
        }
        double tol = root.get("tolerance").asDouble();
        int scaleCases = 0;
        int errorCases = 0;
        for (JsonNode c : root.get("cases")) {
            String name = c.get("name").asText();
            PetSuvCalibration.Type type = PetSuvCalibration.Type.of(c.get("type").asText());
            assertNotNull(type, name);
            PetSuvCalibration.Outcome out = PetSuvCalibration.compute(paramsOf(c.get("params")), type);
            JsonNode exp = c.get("expected");
            if (exp.has("error")) {
                errorCases++;
                assertEquals(exp.get("error").asText(), out.error(), name);
                assertNull(out.scale(), name + ": 失敗では係数を返さない（0 や既定値にしない）");
            } else {
                scaleCases++;
                assertTrue(out.ok(), name + ": " + out.error());
                double e = exp.get("scale").asDouble();
                assertEquals(e, out.scale(), Math.abs(e) * tol, name);
                assertEquals(exp.get("unit").asText(), out.unit(), name);
                assertEquals(exp.get("type").asText(), out.type().id(), name);
                List<String> w = new ArrayList<>();
                exp.get("warnings").forEach(x -> w.add(x.asText()));
                assertEquals(w, out.warnings(), name);
            }
        }
        // 空の比較で通らないよう、両方の種類が実在することを確かめる
        assertTrue(scaleCases >= 15, "係数のケース " + scaleCases);
        assertTrue(errorCases >= 10, "エラーのケース " + errorCases);
    }

    /** 手元の実データ（PSMA PET/CT の PET シリーズ）のヘッダと同じ値の DICOM。身長が無い。 */
    private static Attributes psmaLikePet() {
        Attributes ds = new Attributes();
        ds.setString(Tag.Modality, VR.CS, "PT");
        ds.setString(Tag.Units, VR.CS, "BQML");
        ds.setString(Tag.PatientWeight, VR.DS, "120");
        ds.setString(Tag.PatientSex, VR.CS, "M");
        ds.setString(Tag.SeriesDate, VR.DA, "20230115");
        ds.setString(Tag.SeriesTime, VR.TM, "134208.000000");
        ds.setString(Tag.AcquisitionDate, VR.DA, "20230115");
        ds.setString(Tag.AcquisitionTime, VR.TM, "134208.000000");
        ds.setString(Tag.DecayCorrection, VR.CS, "START");
        ds.setString(Tag.CorrectedImage, VR.CS, "NORM", "DTIM", "ATTN", "SCAT", "DECY", "RAN");
        Attributes rad = new Attributes();
        rad.setString(Tag.RadionuclideTotalDose, VR.DS, "242000000");
        rad.setString(Tag.RadionuclideHalfLife, VR.DS, "6586.2");
        rad.setString(Tag.RadiopharmaceuticalStartTime, VR.TM, "125039.000000");
        Attributes code = new Attributes();
        code.setString(Tag.CodeMeaning, VR.LO, "^18^Fluorine");
        rad.newSequence(Tag.RadionuclideCodeSequence, 1).add(code);
        ds.newSequence(Tag.RadiopharmaceuticalInformationSequence, 1).add(rad);
        return ds;
    }

    @Test
    void extractsTheParametersOfARealPetHeaderAndComputesSuvbw() {
        PetSuvCalibration.Params p = PetSuvCalibration.extract(psmaLikePet());
        assertEquals(120.0, p.patientWeightKg());
        assertNull(p.patientHeightM(), "身長が無いときは null（既定値で埋めない）");
        assertEquals("M", p.patientSex());
        assertEquals(242000000.0, p.totalDoseBq());
        assertEquals(6586.2, p.halfLifeSec());
        assertEquals("BQML", p.units());
        assertEquals("START", p.decayCorrection());
        assertTrue(!p.alreadySuv());
        assertEquals(6, p.correctedImage().size());
        assertEquals(3089_000L, p.scanTimeMs() - p.injectionTimeMs(), "13:42:08 − 12:50:39 = 3089 秒");
        PetSuvCalibration.Outcome bw = PetSuvCalibration.compute(p, PetSuvCalibration.Type.BW);
        assertTrue(bw.ok(), bw.error());
        // Python（exp で独立に計算）: 120000 / (242e6 × exp(−ln2 × 3089 / 6586.2))
        assertEquals(0.0006863604463884588, bw.scale(), 0.0006863604463884588 * 1e-12);
        assertEquals("missingHeight", PetSuvCalibration.compute(p, PetSuvCalibration.Type.SUL_JAMES).error(),
                "身長が無い SUL は計算不可（0 や既定値にしない）");
        assertEquals("missingHeight", PetSuvCalibration.compute(p, PetSuvCalibration.Type.BSA).error());
    }

    @Test
    void fallsBackToTheHalfLifeOfTheNuclideWhenTheTagIsMissing() {
        Attributes ds = psmaLikePet();
        ds.getNestedDataset(Tag.RadiopharmaceuticalInformationSequence).remove(Tag.RadionuclideHalfLife);
        PetSuvCalibration.Params p = PetSuvCalibration.extract(ds);
        assertEquals(6586.2, p.halfLifeSec(), "核種名（Fluorine）から F-18 の半減期");
        ds.getNestedDataset(Tag.RadiopharmaceuticalInformationSequence).remove(Tag.RadionuclideCodeSequence);
        assertNull(PetSuvCalibration.extract(ds).halfLifeSec(), "核種も分からなければ推測しない");
    }

    @Test
    void detectsAnAlreadyCalibratedSeries() {
        Attributes gml = psmaLikePet();
        gml.setString(Tag.Units, VR.CS, "GML");
        assertTrue(PetSuvCalibration.extract(gml).alreadySuv());
        Attributes typed = psmaLikePet();
        typed.setString(Tag.SUVType, VR.CS, "BW");
        assertTrue(PetSuvCalibration.extract(typed).alreadySuv());
        Attributes rescale = psmaLikePet();
        rescale.setString(Tag.RescaleType, VR.LO, "SUV bw");
        assertTrue(PetSuvCalibration.extract(rescale).alreadySuv());
        assertTrue(!PetSuvCalibration.extract(psmaLikePet()).alreadySuv(), "BQML の通常の PET は SUV 化済みではない");
    }

    @Test
    void usesTheSeriesTimeUnlessItIsLaterThanTheAcquisitionTime() {
        Attributes ds = psmaLikePet();
        ds.setString(Tag.AcquisitionTime, VR.TM, "134000.000000"); // 取得が Series より前 → Series は信頼しない
        ds.setString(Tag.SeriesTime, VR.TM, "140000.000000");
        PetSuvCalibration.Params p = PetSuvCalibration.extract(ds);
        long acq = PetSuvCalibration.combineDateTime("20230115", "134000.000000");
        assertEquals(acq, p.scanTimeMs(), "Series Time が Acquisition Time より後なら Acquisition Time を使う");
    }

    // ---- 校正の決定（ValueCalibration.resolve）----

    private static Attributes ct() {
        Attributes ds = new Attributes();
        ds.setString(Tag.Modality, VR.CS, "CT");
        return ds;
    }

    @Test
    void autoCalibratesAPetToSuvbwAndLeavesCtAndMrAlone() {
        ValueCalibration pet = ValueCalibration.resolve("auto", psmaLikePet(), null);
        assertEquals("SUVbw", pet.valueUnit());
        assertEquals("bw", pet.type());
        assertEquals(0.0006863604463884588, pet.scale(), 0.0006863604463884588 * 1e-12);
        assertTrue(pet.scales());
        assertTrue(!pet.uncalibratedPet());
        assertTrue(pet.text().startsWith("bw;scale="), pet.text());

        ValueCalibration hu = ValueCalibration.resolve("auto", ct(), null);
        assertEquals("HU", hu.valueUnit());
        assertTrue(!hu.scales(), "CT は係数を掛けない");
        assertEquals("", hu.text(), "校正しなかったときの Provenance_Calibration は空");
        Attributes mr = new Attributes();
        mr.setString(Tag.Modality, VR.CS, "MR");
        assertEquals(ValueCalibration.UNSET, ValueCalibration.resolve("auto", mr, null), "MR は単位が分からない");
    }

    @Test
    void anExplicitSuvOnANonPetIsRefused() {
        IllegalArgumentException e = org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
                () -> ValueCalibration.resolve("bw", ct(), null));
        assertTrue(e.getMessage().contains("PET") && e.getMessage().contains("CT"), e.getMessage());
        // 校正しない（none）は、PET 以外では何も起きない
        assertEquals("HU", ValueCalibration.resolve("none", ct(), null).valueUnit());
    }

    @Test
    void anUncalibratedPetIsOnlyReadWhenExplicitAndIsFlagged() {
        ValueCalibration none = ValueCalibration.resolve("none", psmaLikePet(), null);
        assertEquals("BQML（未校正）", none.valueUnit());
        assertTrue(none.uncalibratedPet());
        assertTrue(!none.scales(), "Bq/mL のまま係数 1");
        assertTrue(none.text().contains("none") && none.text().contains("uncalibratedPet"), none.text());
    }

    @Test
    void aMissingTagIsRefusedWithTheReasonNotFilledWithADefault() {
        // 身長が無い PET を SUL にすると、理由つきで断る（0 や既定の身長で埋めない）
        IllegalArgumentException e = org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
                () -> ValueCalibration.resolve("sul-james", psmaLikePet(), null));
        assertTrue(e.getMessage().contains("身長"), e.getMessage());
        assertTrue(e.getMessage().contains("校正しない"), "回避策（校正しない・SUVbw）を示す: " + e.getMessage());
        // 投与量が無い PET は auto（SUVbw）でも断る
        Attributes noDose = psmaLikePet();
        noDose.getNestedDataset(Tag.RadiopharmaceuticalInformationSequence).remove(Tag.RadionuclideTotalDose);
        IllegalArgumentException e2 = org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
                () -> ValueCalibration.resolve("auto", noDose, null));
        assertTrue(e2.getMessage().contains("投与量"), e2.getMessage());
    }

    @Test
    void aSeriesThatIsAlreadySuvIsNotCalibratedAgain() {
        Attributes ds = psmaLikePet();
        ds.setString(Tag.Units, VR.CS, "GML");
        for (String req : new String[] { "auto", "bw", "none" }) {
            ValueCalibration vc = ValueCalibration.resolve(req, ds, null);
            assertEquals("SUV（元の値）", vc.valueUnit(), req);
            assertTrue(!vc.scales(), req);
            assertTrue(!vc.uncalibratedPet(), "すでに SUV の系列は未校正の旗を付けない: " + req);
        }
    }

    @Test
    void warnsWhenTheScaleDiffersBetweenTheFirstAndTheLastInstance() {
        Attributes last = psmaLikePet();
        last.setString(Tag.PatientWeight, VR.DS, "119"); // 同じシリーズで体重が違う（壊れたデータ）
        ValueCalibration vc = ValueCalibration.resolve("auto", psmaLikePet(), last);
        assertTrue(vc.warnings().contains("scaleVariesAcrossSlices"), vc.warnings().toString());
        assertEquals(0.0006863604463884588, vc.scale(), 0.0006863604463884588 * 1e-12, "係数は最初のインスタンスから");
        assertTrue(!ValueCalibration.resolve("auto", psmaLikePet(), psmaLikePet()).warnings().contains("scaleVariesAcrossSlices"));
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.dcm4che3.data.Attributes;

/**
 * テスト用の float32 の 3D NIfTI（RAS の sform・原点 (10, 20, 30)・対角の間隔）と、それを Parametric Map にしたもの。
 * 値は {@code value.at(i, j, k)}（NIfTI のボクセル）。
 */
public final class FloatNiftiFixture {

    @FunctionalInterface
    public interface Value {
        float at(int i, int j, int k);
    }

    private FloatNiftiFixture() {
    }

    public static Path write(Path file, int nx, int ny, int nz, double dx, double dy, double dz, Value value)
            throws IOException {
        ByteBuffer b = ByteBuffer.allocate(352 + nx * ny * nz * 4).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(0, 348);
        b.putShort(40, (short) 3);
        b.putShort(42, (short) nx);
        b.putShort(44, (short) ny);
        b.putShort(46, (short) nz);
        b.putShort(48, (short) 1);
        b.putShort(70, (short) NiftiHeader.DT_FLOAT32);
        b.putShort(72, (short) 32);
        float[] pixdim = { 1, (float) dx, (float) dy, (float) dz, 0, 0, 0, 0 };
        for (int i = 0; i < 8; i++) {
            b.putFloat(76 + i * 4, pixdim[i]);
        }
        b.putFloat(108, 352f);
        b.putFloat(112, 1f);
        b.put(123, (byte) 2); // mm
        b.putShort(254, (short) 1);
        float[][] srow = { { (float) dx, 0, 0, 10 }, { 0, (float) dy, 0, 20 }, { 0, 0, (float) dz, 30 } };
        for (int r = 0; r < 3; r++) {
            for (int i = 0; i < 4; i++) {
                b.putFloat(280 + r * 16 + i * 4, srow[r][i]);
            }
        }
        b.position(352);
        for (int k = 0; k < nz; k++) {
            for (int j = 0; j < ny; j++) {
                for (int i = 0; i < nx; i++) {
                    b.putFloat(value.at(i, j, k));
                }
            }
        }
        Files.write(file, b.array());
        return file;
    }

    /** 書いた NIfTI を Parametric Map のインスタンス（画素つき）にする。 */
    public static List<Attributes> toParametricMap(Path nii, String patientId, String patientName, String studyUid,
            String seriesUid, String valueUnit) throws IOException {
        List<Attributes> out = new ArrayList<>();
        NiftiToDicom.convert(nii, new NiftiToDicom.Options("MR", patientId, patientName, "", "", "20261007", "s",
                "adc", 1, studyUid, seriesUid, Map.of(), valueUnit), (ds, ts) -> out.add(new Attributes(ds)));
        return out;
    }
}

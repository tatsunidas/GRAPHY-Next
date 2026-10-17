/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * NIfTI-1 / NIfTI-2 ヘッダ。
 *
 * <p>Swing 版 GRAPHY（{@code com.vis.core.media.NIfTIToDicomConverter} ＋ ImageJ の Nifti_Reader）
 * が読んでいた項目のうち、DICOM 変換に必要なものだけを持つ。ImageJ 依存を持ち込まないため
 * 自前で解析する（backend に ImageJ は入っていない）。
 *
 * <p>バイト順は magic の位置と {@code sizeof_hdr} で判定する（348 / 540 がそのまま読めれば
 * リトルエンディアン、バイトスワップで一致すればビッグエンディアン）。
 */
public final class NiftiHeader {

    /** NIfTI-1 のヘッダ長。 */
    public static final int NIFTI1_HEADER_SIZE = 348;
    /** NIfTI-2 のヘッダ長。 */
    public static final int NIFTI2_HEADER_SIZE = 540;

    /** データ型（NIfTI の datatype コード）。 */
    public static final int DT_UINT8 = 2;
    public static final int DT_INT16 = 4;
    public static final int DT_INT32 = 8;
    public static final int DT_FLOAT32 = 16;
    public static final int DT_INT8 = 256;
    public static final int DT_UINT16 = 512;
    public static final int DT_UINT32 = 768;
    public static final int DT_RGB24 = 128;
    public static final int DT_FLOAT64 = 64;
    public static final int DT_INT64 = 1024;
    public static final int DT_UINT64 = 1280;

    /** 次元（dim[0]=次元数, dim[1]=X, dim[2]=Y, dim[3]=Z, dim[4]=T, dim[5]=C）。 */
    public final long[] dim = new long[8];
    /** 画素間隔（pixdim[1..3] mm, pixdim[4] は TR 相当）。pixdim[0] は qfac。 */
    public final double[] pixdim = new double[8];
    public int datatype;
    public int bitpix;
    public double sclSlope;
    public double sclInter;
    public int qformCode;
    public int sformCode;
    public double quaternB;
    public double quaternC;
    public double quaternD;
    public double qoffsetX;
    public double qoffsetY;
    public double qoffsetZ;
    public final double[] srowX = new double[4];
    public final double[] srowY = new double[4];
    public final double[] srowZ = new double[4];
    public long voxOffset;
    /** 単位コード（xyzt_units）。空間単位は下位 3bit。 */
    public int xyztUnits;
    public String description = "";
    /** NIfTI-2 か。 */
    public boolean nifti2;
    /** ヘッダのバイト順（画素データも同じ順で並ぶ）。 */
    public ByteOrder byteOrder = ByteOrder.LITTLE_ENDIAN;

    /** 利用者の入力から作った Raw データのヘッダか（{@link #raw}）。画素ファイルに gzip の判定をしない。 */
    public boolean raw;

    /** .hdr＋.img の 2 ファイル形式の種類（{@link #parsePair}）。.nii では null。 */
    public enum PairKind { NIFTI_PAIR, ANALYZE }

    public PairKind pairKind;
    /** ANALYZE の hist.orient（252 バイト目）。向きには使わず、記録だけする。 */
    public int analyzeOrient = -1;
    /** bitpix が datatype と食い違っていたときの説明（datatype から読み直した）。 */
    public String bitpixNote;
    /**
     * 画素ファイルが gzip か。null は先頭のマジックで判定する（.nii）。true・false は拡張子で決めた（.img／.img.gz）——
     * 圧縮していない .img の先頭がたまたま 0x1F 0x8B だと、マジックの判定では取り違えるため。
     */
    public Boolean dataGzip;

    private NiftiHeader() {
    }

    /**
     * ヘッダの無い画素配列（Raw）を、利用者が申告した寸法・型・幾何から NIfTI のヘッダとして組む。
     * 画素は x が最速 → y → z → t の順で、{@code offset} バイト目から並ぶ前提。
     *
     * <p>幾何は患者座標 LPS で受け取り、sform（RAS）に直して入れる。スライス方向は行 × 列（右手系）なので、
     * {@link NiftiGeometry} の列の反転は起きず、画素は行 0 を上としてそのまま並ぶ。pixdim にも同じ間隔を入れて、
     * アフィンと pixdim の大きさの照合（{@link NiftiGeometry#of}）が食い違わないようにする。
     *
     * @param rowLps    行方向（列番号が増える向き）の単位ベクトル
     * @param colLps    列方向（行番号が増える向き）の単位ベクトル
     * @param spacingMm {x, y, z} の画素間隔 mm
     * @param originLps 先頭画素の中心の位置 mm
     */
    public static NiftiHeader raw(int nx, int ny, int nz, int nt, int datatype, ByteOrder order, long offset,
                                  double[] spacingMm, double[] rowLps, double[] colLps, double[] originLps) {
        NiftiHeader h = new NiftiHeader();
        h.raw = true;
        h.datatype = datatype;
        if (datatype == DT_RGB24 || datatype == DT_INT64 || datatype == DT_UINT64) {
            throw new IllegalArgumentException("Raw で扱わないデータ型です: datatype=" + datatype);
        }
        h.bitpix = bitsOf(datatype);
        if (h.bitpix == 0) {
            throw new IllegalArgumentException("Raw で扱わないデータ型です: datatype=" + datatype);
        }
        h.dim[0] = nt > 1 ? 4 : 3;
        h.dim[1] = nx;
        h.dim[2] = ny;
        h.dim[3] = nz;
        h.dim[4] = Math.max(1, nt);
        h.pixdim[0] = 1;
        for (int i = 0; i < 3; i++) {
            h.pixdim[i + 1] = spacingMm[i];
        }
        h.voxOffset = offset;
        h.byteOrder = order;
        h.sclSlope = 1;
        h.sclInter = 0;
        h.xyztUnits = 2; // mm
        double[] n = {
            rowLps[1] * colLps[2] - rowLps[2] * colLps[1],
            rowLps[2] * colLps[0] - rowLps[0] * colLps[2],
            rowLps[0] * colLps[1] - rowLps[1] * colLps[0],
        };
        double[][] lps = new double[3][4];
        for (int a = 0; a < 3; a++) {
            lps[a][0] = rowLps[a] * spacingMm[0];
            lps[a][1] = colLps[a] * spacingMm[1];
            lps[a][2] = n[a] * spacingMm[2];
            lps[a][3] = originLps[a];
        }
        // LPS → RAS（x 行と y 行の符号を反転）。NiftiGeometry が LPS へ戻す
        for (int i = 0; i < 4; i++) {
            h.srowX[i] = lps[0][i] == 0 ? 0 : -lps[0][i];
            h.srowY[i] = lps[1][i] == 0 ? 0 : -lps[1][i];
            h.srowZ[i] = lps[2][i];
        }
        h.sformCode = 1;
        return h;
    }

    /**
     * 先頭バイト列からヘッダを読む。
     *
     * @param head 少なくとも 540 バイト（NIfTI-2 のヘッダ長）読めていること
     */
    public static NiftiHeader parse(byte[] head) throws IOException {
        if (head.length < NIFTI1_HEADER_SIZE) {
            throw new IOException("NIfTI ヘッダが短すぎます: " + head.length + " バイト");
        }
        ByteBuffer le = ByteBuffer.wrap(head).order(ByteOrder.LITTLE_ENDIAN);
        int sizeofLe = le.getInt(0);
        ByteOrder order;
        boolean nifti2;
        if (sizeofLe == NIFTI1_HEADER_SIZE) {
            order = ByteOrder.LITTLE_ENDIAN;
            nifti2 = false;
        } else if (sizeofLe == NIFTI2_HEADER_SIZE) {
            order = ByteOrder.LITTLE_ENDIAN;
            nifti2 = true;
        } else {
            int sizeofBe = ByteBuffer.wrap(head).order(ByteOrder.BIG_ENDIAN).getInt(0);
            if (sizeofBe == NIFTI1_HEADER_SIZE) {
                order = ByteOrder.BIG_ENDIAN;
                nifti2 = false;
            } else if (sizeofBe == NIFTI2_HEADER_SIZE) {
                order = ByteOrder.BIG_ENDIAN;
                nifti2 = true;
            } else {
                throw new IOException("NIfTI ではありません（sizeof_hdr=" + sizeofLe + "）");
            }
        }
        if (nifti2 && head.length < NIFTI2_HEADER_SIZE) {
            throw new IOException("NIfTI-2 ヘッダが短すぎます: " + head.length + " バイト");
        }
        ByteBuffer b = ByteBuffer.wrap(head).order(order);
        NiftiHeader h = new NiftiHeader();
        h.byteOrder = order;
        h.nifti2 = nifti2;
        if (nifti2) {
            h.datatype = b.getShort(12);
            h.bitpix = b.getShort(14);
            for (int i = 0; i < 8; i++) {
                h.dim[i] = b.getLong(16 + i * 8);
            }
            for (int i = 0; i < 8; i++) {
                h.pixdim[i] = b.getDouble(104 + i * 8);
            }
            h.voxOffset = b.getLong(168);
            h.sclSlope = b.getDouble(176);
            h.sclInter = b.getDouble(184);
            h.description = readString(head, 240, 80);
            h.qformCode = b.getInt(344);
            h.sformCode = b.getInt(348);
            h.quaternB = b.getDouble(352);
            h.quaternC = b.getDouble(360);
            h.quaternD = b.getDouble(368);
            h.qoffsetX = b.getDouble(376);
            h.qoffsetY = b.getDouble(384);
            h.qoffsetZ = b.getDouble(392);
            for (int i = 0; i < 4; i++) {
                h.srowX[i] = b.getDouble(400 + i * 8);
                h.srowY[i] = b.getDouble(432 + i * 8);
                h.srowZ[i] = b.getDouble(464 + i * 8);
            }
            h.xyztUnits = b.getInt(500);
        } else {
            for (int i = 0; i < 8; i++) {
                h.dim[i] = b.getShort(40 + i * 2);
            }
            h.datatype = b.getShort(70);
            h.bitpix = b.getShort(72);
            for (int i = 0; i < 8; i++) {
                h.pixdim[i] = b.getFloat(76 + i * 4);
            }
            h.voxOffset = (long) b.getFloat(108);
            h.sclSlope = b.getFloat(112);
            h.sclInter = b.getFloat(116);
            h.xyztUnits = head[123] & 0xFF;
            h.description = readString(head, 148, 80);
            h.qformCode = b.getShort(252);
            h.sformCode = b.getShort(254);
            h.quaternB = b.getFloat(256);
            h.quaternC = b.getFloat(260);
            h.quaternD = b.getFloat(264);
            h.qoffsetX = b.getFloat(268);
            h.qoffsetY = b.getFloat(272);
            h.qoffsetZ = b.getFloat(276);
            for (int i = 0; i < 4; i++) {
                h.srowX[i] = b.getFloat(280 + i * 4);
                h.srowY[i] = b.getFloat(296 + i * 4);
                h.srowZ[i] = b.getFloat(312 + i * 4);
            }
        }
        if (h.voxOffset <= 0) {
            h.voxOffset = nifti2 ? NIFTI2_HEADER_SIZE : NIFTI1_HEADER_SIZE + 4;
        }
        if (h.sclSlope == 0) {
            // slope=0 は「スケーリング無し」の意味（NIfTI 仕様）。1 として扱う。
            h.sclSlope = 1;
            h.sclInter = 0;
        }
        return h;
    }

    /** datatype の 1 画素のビット数。知らない型は 0。 */
    static int bitsOf(int datatype) {
        return switch (datatype) {
            case DT_UINT8, DT_INT8 -> 8;
            case DT_INT16, DT_UINT16 -> 16;
            case DT_RGB24 -> 24;
            case DT_INT32, DT_UINT32, DT_FLOAT32 -> 32;
            case DT_FLOAT64, DT_INT64, DT_UINT64 -> 64;
            default -> 0;
        };
    }

    /**
     * .hdr＋.img の 2 ファイル形式のヘッダを読む（fw/nifti-import.md §9）。344 バイト目の magic が "ni1" なら NIfTI の 2 ファイル形式、
     * 無ければ ANALYZE 7.5。
     *
     * <p>ANALYZE には患者座標が無く、{@link #parse} が qform・sform として読む 252 バイト目以降は {@code hist.orient}・{@code originator}
     * なので、qform・sform を 0 にする（向きは合成の軸位断になる）。orient は反転の解釈がソフトごとに割れているので向きには使わない。
     * voxOffset は .img の先頭からの値をそのまま使う（{@link #parse} の「0 なら 352」は 1 ファイル形式のための補正）。
     * bitpix は datatype から導き直す（食い違うファイルが実在する。ITK のテストデータの BigEndian.hdr は bitpix=5）。
     *
     * <p>.nii（1 ファイル形式）はこれを通らない——magic を書いていない NIfTI がテストに多く、判定を変えると既存の扱いが変わるため。
     */
    public static NiftiHeader parsePair(byte[] head) throws IOException {
        NiftiHeader h = parse(head);
        if (h.nifti2) {
            throw new IOException("NIfTI-2 の 2 ファイル形式には対応していません");
        }
        boolean niftiPair = head.length >= 348 && head[344] == 'n' && head[345] == 'i' && head[346] == '1' && head[347] == 0;
        ByteBuffer b = ByteBuffer.wrap(head).order(h.byteOrder);
        h.voxOffset = Math.max(0, (long) b.getFloat(108));
        if (niftiPair) {
            h.pairKind = PairKind.NIFTI_PAIR;
        } else {
            h.pairKind = PairKind.ANALYZE;
            h.analyzeOrient = head[252];
            h.qformCode = 0;
            h.sformCode = 0;
            h.xyztUnits = 0; // ANALYZE に単位の欄は無い（mm とみなす）
        }
        int bits = bitsOf(h.datatype);
        if (bits == 0) {
            throw new IOException("未対応のデータ型です: datatype=" + h.datatype);
        }
        if (h.bitpix != bits) {
            h.bitpixNote = "bitpix=" + h.bitpix + " は datatype=" + h.datatype + "（" + bits + " bit）と食い違うので datatype から読んだ";
            h.bitpix = bits;
        }
        return h;
    }

    private static String readString(byte[] src, int offset, int max) {
        int end = offset;
        while (end < offset + max && end < src.length && src[end] != 0) {
            end++;
        }
        return new String(src, offset, end - offset, java.nio.charset.StandardCharsets.ISO_8859_1).trim();
    }

    public int nx() {
        return (int) Math.max(1, dim[1]);
    }

    public int ny() {
        return (int) Math.max(1, dim[2]);
    }

    /** スライス数（Z）。 */
    public int nz() {
        return dim[0] >= 3 ? (int) Math.max(1, dim[3]) : 1;
    }

    /** 時相数（T）。4D の 4 次元目。 */
    public int nt() {
        return dim[0] >= 4 ? (int) Math.max(1, dim[4]) : 1;
    }

    /** チャネル数（5 次元目）。 */
    public int nc() {
        return dim[0] >= 5 ? (int) Math.max(1, dim[5]) : 1;
    }

    /** 面内画素間隔（列方向 x, 行方向 y）mm。 */
    public double spacingX() {
        return pixdim[1] > 0 ? pixdim[1] : 1;
    }

    public double spacingY() {
        return pixdim[2] > 0 ? pixdim[2] : 1;
    }

    /** スライス間隔 mm。 */
    public double spacingZ() {
        return pixdim[3] > 0 ? pixdim[3] : 1;
    }

    /** 1 画素あたりのバイト数。 */
    public int bytesPerVoxel() {
        return Math.max(1, bitpix / 8);
    }

    /** 空間単位がメートル/マイクロメートルの場合に mm へ直す係数。 */
    public double spatialUnitToMm() {
        int unit = xyztUnits & 0x07;
        return switch (unit) {
            case 1 -> 1000.0; // meter
            case 3 -> 0.001; // micron
            default -> 1.0; // mm（既定・未指定を含む）
        };
    }
}

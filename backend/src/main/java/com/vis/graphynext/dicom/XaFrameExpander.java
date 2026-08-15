/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

/**
 * XA / XRF の古典マルチフレーム（シネ）を ZCT レイアウトへ展開する（fw/angio-design.md §5.2）。
 *
 * <p><b>展開の形</b>: 1 インスタンス = 1 ラン（撮影）で、その中に {@code NumberOfFrames} 枚の
 * フレームが入っている。これを
 * <ul>
 *   <li><b>Z 軸 = ラン</b>（nZ = インスタンス数。UI ラベルは "Run"）</li>
 *   <li><b>T 軸 = フレーム</b>（nT = 最大フレーム数。UI ラベルは "Frame"）</li>
 *   <li><b>stackAxis = "t"</b>（＝フレーム列を Cornerstone のスタックにする）</li>
 * </ul>
 * として載せる。Z にランを載せるのはデータ構造の都合であり、<b>UI に "Z" とは出さない</b>
 * （{@link SeriesLayout.Axes} が提示を供給する）。
 *
 * <p><b>stackAxis="t" の理由</b>: スタックは Cornerstone StackViewport の imageIds ＝ホイール送り・
 * プリフェッチ・Grid の単位である。従来どおり Z をスタックにすると、XA では
 * <b>フレームを送るたびに setStack が走り 30fps に届かない</b>（ホイール送りも死ぬ）。
 *
 * <p><b>フレーム数がランごとに違う場合</b>: nT は最大値にし、足りないランは
 * <b>そのランの最終フレームを指すセルで埋める</b>。ブランク画像を挟むと再生中に黒画面が
 * 点滅するため。UI から見ると「短いランは最終フレームで止まる」ように見える。
 *
 * <p><b>幾何は付けない</b>: 投影像には患者座標の断面が無いため IOP / ZSpatial / FrameOfReference は
 * 付与しない（＝シリーズ Sync・参照線・MPR が誤って有効化されない）。空間校正は
 * frontend の {@code viewer/xaCalibration.ts} が担当する（fw/angio-design.md §7）。
 */
public final class XaFrameExpander {

    private XaFrameExpander() {
    }

    /**
     * シネとして展開する SOP クラス（fw/angio-design.md §3）。
     * X-Ray 3D Angiographic (13.1.1) は再構成ボリュームなので<b>含めない</b>（従来の Z スタック経路が正しい）。
     */
    private static final Set<String> XA_SOP_CLASSES = Set.of(
            "1.2.840.10008.5.1.4.1.1.12.1",    // X-Ray Angiographic Image Storage
            "1.2.840.10008.5.1.4.1.1.12.1.1",  // Enhanced XA Image Storage
            "1.2.840.10008.5.1.4.1.1.12.2",    // X-Ray Radiofluoroscopic Image Storage
            "1.2.840.10008.5.1.4.1.1.12.2.1",  // Enhanced XRF Image Storage
            "1.2.840.10008.5.1.4.1.1.12.3"     // X-Ray Angiographic Bi-Plane (Retired)
    );

    /**
     * XA/XRF か（＝フレーム軸として扱う対象）。
     *
     * <p><b>フレーム数では判定しない</b>。XA は投影像なので Z 軸に意味が無く、フレームが 1 枚でも
     * 「時間軸に 1 枚」が正しい軸の意味になる（設計 §5.7）。フレーム数で切り分けていたため、
     * <b>単一フレームの XA では校正・QCA の導線がまるごと出なかった</b>
     * （GNBP-XA-4 の校正変種が 1 フレームで、実機検証で踏んだ）。単一フレームの
     * アンギオ／XRF スポット像は実在するので、これは実データでも起きる。
     *
     * <p>フレーム数 1 のときスライダーは出ない（`count > 1` ガード）ので、UI 上の副作用は
     * 「XA の操作行が出る」ことだけ。
     */
    public static boolean isXaCine(Attributes ds) {
        if (ds == null) {
            return false;
        }
        String sopClass = ds.getString(Tag.SOPClassUID);
        return sopClass != null && XA_SOP_CLASSES.contains(sopClass);
    }

    /**
     * XA シネのレイアウトを組む。渡されたヘッダ群に XA シネが 1 つも無ければ null（＝従来経路へ）。
     *
     * <p>XA シネと非 XA が混在するシリーズでは XA シネのみを採用する（混ぜると軸の意味が壊れるため）。
     *
     * @param headers シリーズ内各インスタンスのヘッダ（ピクセル無しで可）
     */
    public static SeriesLayout layout(List<Attributes> headers) {
        if (headers == null || headers.isEmpty()) {
            return null;
        }
        List<Attributes> runs = new ArrayList<>();
        for (Attributes ds : headers) {
            if (isXaCine(ds)) {
                runs.add(ds);
            }
        }
        if (runs.isEmpty()) {
            return null;
        }
        // ラン順は InstanceNumber（無ければ 0）→ SOPInstanceUID で決定的に。
        runs.sort(Comparator
                .comparingInt((Attributes a) -> a.getInt(Tag.InstanceNumber, 0))
                .thenComparing(a -> nullToEmpty(a.getString(Tag.SOPInstanceUID))));

        int nZ = runs.size();
        int nT = 0;
        for (Attributes ds : runs) {
            nT = Math.max(nT, Math.max(1, ds.getInt(Tag.NumberOfFrames, 1)));
        }

        List<SeriesLayout.Cell> cells = new ArrayList<>(nZ * nT);
        for (int z = 0; z < nZ; z++) {
            Attributes ds = runs.get(z);
            String sop = ds.getString(Tag.SOPInstanceUID);
            int frames = Math.max(1, ds.getInt(Tag.NumberOfFrames, 1));
            for (int t = 0; t < nT; t++) {
                // 短いランは最終フレームで止める（ブランクを挟まない）。
                int frame = Math.min(t, frames - 1);
                cells.add(new SeriesLayout.Cell(0, z, t, sop, frame));
            }
        }

        Attributes first = runs.get(0);
        int cols = first.getInt(Tag.Columns, 0);
        int rows = first.getInt(Tag.Rows, 0);

        SeriesLayout.Axes axes = new SeriesLayout.Axes(
                new SeriesLayout.Axis("Run", "run"),
                null,
                new SeriesLayout.Axis("Frame", "frame"),
                "t");

        return new SeriesLayout(
                nZ, 1, nT,
                null, null, cells,
                // 投影像なので幾何は付けない（Sync/参照線/MPR を誤って有効化しない）。
                null, 0, 0, cols, rows, null, null,
                SeriesLayoutAssembler.readPixelFormat(first),
                axes);
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}

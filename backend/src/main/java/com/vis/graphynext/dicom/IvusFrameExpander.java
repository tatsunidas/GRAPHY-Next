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
 * 血管内画像（IVUS / OCT）の古典マルチフレームを ZCT レイアウトへ展開する
 * （fw/angio-design.md §12 / A8）。
 *
 * <p><b>なぜ要るのか</b>: {@link SeriesLayoutAssembler} はマルチフレームの展開を SEG / NM / XA の
 * 3 つにしか委譲しておらず、それ以外は {@code NumberOfFrames} を<b>一切見ない</b>。
 * つまり IVUS の pullback（数百フレーム）を取り込んでも
 * <b>1 インスタンス = 1 セルになり、先頭フレームしか表示されない</b>。
 * A8 の同期ロジック以前に、ここが塞がっていないと何も始まらない。
 *
 * <p><b>展開の形</b>（XA と同じ骨格）:
 * <ul>
 *   <li><b>Z 軸 = プルバック</b>（1 インスタンス = 1 プルバック。普通は 1 本なので nZ=1）</li>
 *   <li><b>T 軸 = フレーム</b>（＝カテーテルの引き抜き位置。時間軸でもある）</li>
 *   <li><b>stackAxis = "t"</b>（フレーム列を Cornerstone のスタックにする）</li>
 * </ul>
 * nZ=1 のとき Z のスライダーは出ない（{@code count > 1} ガード・設計 §5.7）ので、
 * 利用者から見えるのはフレーム軸だけになる。
 *
 * <p><b>🔴 心エコーを巻き込まない</b>: US Multi-frame（1.1.3.1）は<b>心エコーでも使われる</b>ので、
 * SOP クラスだけで判定すると通常の超音波シネまでこの経路に入る。血管内かどうかは
 * <b>{@code Modality} が IVUS か</b>で切り分ける。IVOCT は SOP クラス自体が血管内専用なので
 * モダリティを問わない。
 *
 * <p>⚠️ <b>既知の穴（今回の範囲外）</b>: 通常の超音波マルチフレーム（心エコー）は依然として
 * 先頭フレームしか出ない。原因はこのクラスと同じ「展開されていない」ことで、同じ器で塞げるが、
 * 既存の心エコー検査の見え方を変える話なので別途判断する。
 *
 * <p><b>幾何は付けない</b>: 断層像ではあるが、患者座標での位置は
 * <b>アンギオ上のプルバック経路との対応づけ</b>（§12.2）で初めて決まる。ここで
 * IOP / FrameOfReference を付けると、シリーズ Sync・参照線・MPR が誤って有効化される。
 */
public final class IvusFrameExpander {

    private IvusFrameExpander() {
    }

    /** 血管内 OCT。SOP クラス自体が血管内専用なのでモダリティを問わない。 */
    private static final Set<String> IVOCT_SOP_CLASSES = Set.of(
            "1.2.840.10008.5.1.4.1.1.14.1",  // Intravascular OCT Image Storage - For Presentation
            "1.2.840.10008.5.1.4.1.1.14.2"   // Intravascular OCT Image Storage - For Processing
    );

    /** 超音波マルチフレーム。<b>心エコーでも使われる</b>ので Modality で切り分ける。 */
    private static final String US_MULTI_FRAME_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.3.1";

    /** 血管内超音波を表すモダリティ。 */
    private static final String MODALITY_IVUS = "IVUS";

    /**
     * 血管内画像のマルチフレームか（＝フレーム軸として扱う対象）。
     *
     * <p><b>フレーム数では判定しない</b>（XA と同じ理由）。プルバックが 1 枚しか無い収集でも
     * 「時間軸に 1 枚」が正しい軸の意味で、フレーム数で切り分けると
     * <b>1 枚の収集だけ別の見え方になる</b>。
     */
    public static boolean isIntravascular(Attributes ds) {
        if (ds == null) {
            return false;
        }
        String sopClass = ds.getString(Tag.SOPClassUID);
        if (sopClass == null) {
            return false;
        }
        if (IVOCT_SOP_CLASSES.contains(sopClass)) {
            return true;
        }
        if (!US_MULTI_FRAME_SOP_CLASS.equals(sopClass)) {
            return false;
        }
        String modality = ds.getString(Tag.Modality);
        return MODALITY_IVUS.equalsIgnoreCase(modality == null ? null : modality.trim());
    }

    /**
     * IVUS / OCT のレイアウトを組む。対象が 1 つも無ければ null（＝従来経路へ）。
     *
     * <p>血管内画像と非血管内が混在するシリーズでは血管内のみを採用する
     * （混ぜると軸の意味が壊れる。XA と同じ扱い）。
     *
     * @param headers シリーズ内各インスタンスのヘッダ（ピクセル無しで可）
     */
    public static SeriesLayout layout(List<Attributes> headers) {
        if (headers == null || headers.isEmpty()) {
            return null;
        }
        List<Attributes> pullbacks = new ArrayList<>();
        for (Attributes ds : headers) {
            if (isIntravascular(ds)) {
                pullbacks.add(ds);
            }
        }
        if (pullbacks.isEmpty()) {
            return null;
        }
        // 順序は InstanceNumber（無ければ 0）→ SOPInstanceUID で決定的に。
        pullbacks.sort(Comparator
                .comparingInt((Attributes a) -> a.getInt(Tag.InstanceNumber, 0))
                .thenComparing(a -> nullToEmpty(a.getString(Tag.SOPInstanceUID))));

        int nZ = pullbacks.size();
        int nT = 0;
        for (Attributes ds : pullbacks) {
            nT = Math.max(nT, Math.max(1, ds.getInt(Tag.NumberOfFrames, 1)));
        }

        List<SeriesLayout.Cell> cells = new ArrayList<>(nZ * nT);
        for (int z = 0; z < nZ; z++) {
            Attributes ds = pullbacks.get(z);
            String sop = ds.getString(Tag.SOPInstanceUID);
            int frames = Math.max(1, ds.getInt(Tag.NumberOfFrames, 1));
            for (int t = 0; t < nT; t++) {
                // 短いプルバックは最終フレームで止める（ブランクを挟まない。XA と同じ）。
                int frame = Math.min(t, frames - 1);
                cells.add(new SeriesLayout.Cell(0, z, t, sop, frame));
            }
        }

        Attributes first = pullbacks.get(0);
        int cols = first.getInt(Tag.Columns, 0);
        int rows = first.getInt(Tag.Rows, 0);

        SeriesLayout.Axes axes = new SeriesLayout.Axes(
                new SeriesLayout.Axis("Pullback", "pullback"),
                null,
                new SeriesLayout.Axis("Frame", "frame"),
                "t");

        return new SeriesLayout(
                nZ, 1, nT,
                null, null, cells,
                // 患者座標での位置はアンギオ側との対応づけで決まる（§12.2）。ここでは付けない。
                null, 0, 0, cols, rows, null, null,
                SeriesLayoutAssembler.readPixelFormat(first),
                axes);
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}

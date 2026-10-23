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
 * 超音波（心エコー等）のマルチフレーム・シネを Shot × Frame へ展開する（{@code fw/series-axes.md}）。
 *
 * <p><b>展開の形</b>は {@link XaFrameExpander} と同じ: 1 インスタンス = 1 ショット、その中の
 * {@code NumberOfFrames} 枚が時間順のフレーム。Z 軸 = ショット（UI ラベル "Shot"）、T 軸 = フレーム
 * （"Frame"）、{@code stackAxis="t"}。幾何は付けない（空間位置の繰り返しを前提としない）。
 * ショットごとにフレーム数が違ってよく、セルは実在するフレームの分だけ作る。
 *
 * <p>これが無かったときは、マルチフレームの US が<b>先頭 1 フレームしか出なかった</b>
 * （従来経路は NumberOfFrames を見ない）。
 *
 * <p><b>🔴 時間のシネだけを対象にする</b>。US マルチフレームは、フリーハンド 3D のスイープ（フレームが
 * 空間位置の並び）も同じ IOD に入る。Frame Increment Pointer だけでは時間か空間か決められないので、
 * <b>空間であることを示す手がかりがあるシリーズは展開せず null を返す</b>（従来経路＝先頭フレームのまま。
 * 時間のシネとして並べると軸の意味が嘘になる）。手がかりは次のいずれか:
 * <ul>
 *   <li>Frame Increment Pointer があり、時間を表すタグ（Frame Time / Frame Time Vector）を含まない</li>
 *   <li>トップレベルの ImagePositionPatient / ImageOrientationPatient がある</li>
 *   <li>Per-Frame Functional Groups Sequence がある（フレームごとの位置を持ち得る）</li>
 * </ul>
 * Enhanced US Volume（1.2.840.10008.5.1.4.1.1.6.2）は空間スライスの体積なので、ここでは扱わない（Z/C/T）。
 *
 * <p><b>血管内 US（IVUS）を奪わない</b>: Modality が IVUS のものは {@link IvusFrameExpander} が先に取る。
 * 呼び出し側はその後ろにこの展開器を置くこと。この展開器自身も IVUS を対象から外す。
 *
 * <p>標準の確認状況: Frame Time / Frame Time Vector が「FIP が指すときに必須」であること
 * （PS3.3 C.7.6.5）は一次資料で確認済み。US のスイープの扱いは未確認の見立て（{@code fw/series-axes.md} §4）。
 */
public final class UsFrameExpander {

    private UsFrameExpander() {
    }

    /** US Multi-frame Image Storage。 */
    private static final String US_MULTI_FRAME = "1.2.840.10008.5.1.4.1.1.3.1";
    /** US Image Storage。単フレームが普通だが、複数フレームを持つことがある（その場合だけ対象）。 */
    private static final String US_IMAGE = "1.2.840.10008.5.1.4.1.1.6.1";

    private static final Set<Integer> TIME_POINTERS = Set.of(Tag.FrameTime, Tag.FrameTimeVector);

    /** 展開の対象の SOP か（IVUS は除く）。フレーム数・時間か空間かの判定は含まない。 */
    static boolean isUsCandidate(Attributes ds) {
        if (ds == null || IvusFrameExpander.isIntravascular(ds)) {
            return false;
        }
        String sopClass = ds.getString(Tag.SOPClassUID);
        return US_MULTI_FRAME.equals(sopClass) || US_IMAGE.equals(sopClass);
    }

    /** 空間（スイープ）であることを示す手がかりがあるか。あれば時間のシネとして展開しない。 */
    static boolean looksSpatial(Attributes ds) {
        int[] fip = ds.getInts(Tag.FrameIncrementPointer);
        if (fip != null && fip.length > 0) {
            boolean time = false;
            for (int t : fip) {
                if (TIME_POINTERS.contains(t)) {
                    time = true;
                    break;
                }
            }
            if (!time) {
                return true;
            }
        }
        return ds.contains(Tag.ImagePositionPatient)
                || ds.contains(Tag.ImageOrientationPatient)
                || ds.contains(Tag.PerFrameFunctionalGroupsSequence);
    }

    /**
     * US シネのレイアウトを組む。展開しない（対象が無い・単フレームだけ・空間の手がかりあり）ときは null
     * （＝従来経路へ）。
     *
     * @param headers シリーズ内各インスタンスのヘッダ（ピクセル無しで可）
     */
    public static SeriesLayout layout(List<Attributes> headers) {
        if (headers == null || headers.isEmpty()) {
            return null;
        }
        List<Attributes> shots = new ArrayList<>();
        boolean multiFrame = false;
        for (Attributes ds : headers) {
            if (!isUsCandidate(ds)) {
                continue;
            }
            if (looksSpatial(ds)) {
                return null; // 1 つでも空間の手がかりがあれば、そのシリーズは展開しない
            }
            shots.add(ds);
            multiFrame |= ds.getInt(Tag.NumberOfFrames, 1) > 1;
        }
        // 単フレームの US だけのシリーズは従来経路（Z スタック）のまま。挙動を変えない。
        if (shots.isEmpty() || !multiFrame) {
            return null;
        }
        shots.sort(Comparator
                .comparingInt((Attributes a) -> a.getInt(Tag.InstanceNumber, 0))
                .thenComparing(a -> nullToEmpty(a.getString(Tag.SOPInstanceUID))));

        int nZ = shots.size();
        int nT = 0;
        List<SeriesLayout.Cell> cells = new ArrayList<>();
        for (int z = 0; z < nZ; z++) {
            Attributes ds = shots.get(z);
            String sop = ds.getString(Tag.SOPInstanceUID);
            int frames = Math.max(1, ds.getInt(Tag.NumberOfFrames, 1));
            nT = Math.max(nT, frames);
            for (int t = 0; t < frames; t++) {
                cells.add(new SeriesLayout.Cell(0, z, t, sop, t));
            }
        }

        Attributes first = shots.get(0);
        SeriesLayout.Axes axes = new SeriesLayout.Axes(
                new SeriesLayout.Axis("Shot", "shot"),
                null,
                new SeriesLayout.Axis("Frame", "frame"),
                "t");

        return new SeriesLayout(
                nZ, 1, nT,
                null, null, cells,
                null, 0, 0, first.getInt(Tag.Columns, 0), first.getInt(Tag.Rows, 0), null, null,
                SeriesLayoutAssembler.readPixelFormat(first),
                axes);
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}

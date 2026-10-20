/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * 4D シリーズの T 次元の**経過時間**（先頭の取得からの秒）を、各セル（SOP）のヘッダ時刻から決める。
 *
 * <p>いまのレイアウトは T を順序（TemporalPositionIdentifier / TriggerTime / AcquisitionNumber）でしか
 * 持たず、「何秒目か」が分からない。灌流の立ち上がりの傾きや曲線下面積は経過時間が要るので、ここで付ける。
 *
 * <h3>方針（迷うときは null。秒を作り出さない）</h3>
 * 出所の優先順は ① {@code AcquisitionTime}（日付があれば日付込み）→ ② {@code TriggerTime}（ms）→ なし。
 * 採用の条件（満たさなければ次の出所、全部だめなら null）:
 * <ul>
 *   <li>全セルに値がある（1 セルでも欠ければ不採用。欠けた点を 0 や補間で埋めない）</li>
 *   <li>各 (c,z) の連鎖を t の昇順に並べて、値が<b>厳密に増加</b>する（等しい・減るは不採用）</li>
 *   <li>時刻だけで日付が無いとき、0 時をまたぐと減少として現れて不採用になる（日付なしで日跨ぎを推測しない）</li>
 *   <li>日付つきと日付なしが混在するときは不採用</li>
 * </ul>
 * 採用したら出所の最小値を 0 とした秒にする。<b>スライスごとに取得時刻が違う（DCE の典型）</b>ので、
 * セル（SOP）単位で持つ。
 *
 * <p>⚠ {@code TriggerTime} は心臓 cine では R 波からの時間で、「検査の経過時間」とは別の時計。出所を必ず
 * 一緒に返すので、利用者はそれを見て解釈する。NIfTI 由来の {@code TriggerTime} は TR（pixdim[4]）から作られる
 * （TR が無いときは時相番号）ので、TR の値を信用する前提になる。
 *
 * <p>1 つの SOP が異なる時相にまたがるマルチフレーム（XA・NM 等）は、SOP 単位の時刻では時相を区別できず、
 * 同じ SOP の値が等しくなって「厳密な増加」を満たさないので自然に対象外（null）になる。
 * Siemens モザイク（1 SOP＝同じ時相の複数スライス）は、時相ごとに SOP が違うので対象になる。
 */
public final class LayoutTimeAxis {

    public static final String SOURCE_ACQUISITION = "AcquisitionTime";
    public static final String SOURCE_TRIGGER = "TriggerTime";

    /** ヘッダから読んだ時刻のタグ。値が無ければ null。 */
    public record TimeTags(String acquisitionDate, String acquisitionTime, Double triggerTimeMs) {
    }

    private LayoutTimeAxis() {
    }

    public static TimeTags read(Attributes ds) {
        double trig = ds.getDouble(Tag.TriggerTime, Double.NaN);
        return new TimeTags(ds.getString(Tag.AcquisitionDate), ds.getString(Tag.AcquisitionTime),
                Double.isNaN(trig) || Double.isInfinite(trig) ? null : trig);
    }

    /** 時間軸を決める。付けられなければ null。 */
    public static SeriesLayout.TimeAxis compute(SeriesLayout layout, Map<String, TimeTags> tagsBySop) {
        if (layout == null || layout.nT() <= 1 || layout.cells() == null || layout.cells().isEmpty()
                || tagsBySop == null) {
            return null;
        }
        Map<String, Double> acq = acquisitionSeconds(layout, tagsBySop);
        if (acq != null && strictlyIncreasing(layout, acq)) {
            return new SeriesLayout.TimeAxis(SOURCE_ACQUISITION, zeroBased(acq));
        }
        Map<String, Double> trig = perCell(layout, tagsBySop, t -> t.triggerTimeMs() == null ? null : t.triggerTimeMs() / 1000.0);
        if (trig != null && strictlyIncreasing(layout, trig)) {
            return new SeriesLayout.TimeAxis(SOURCE_TRIGGER, zeroBased(trig));
        }
        return null;
    }

    /** 全セルに値があれば SOP → 値、1 つでも欠ければ null。 */
    private static Map<String, Double> perCell(SeriesLayout layout, Map<String, TimeTags> tags,
                                               Function<TimeTags, Double> pick) {
        Map<String, Double> out = new HashMap<>();
        for (SeriesLayout.Cell cell : layout.cells()) {
            TimeTags t = tags.get(cell.sopInstanceUid());
            Double v = t == null ? null : pick.apply(t);
            if (v == null || v.isNaN() || v.isInfinite()) {
                return null;
            }
            out.put(cell.sopInstanceUid(), v);
        }
        return out;
    }

    /** AcquisitionTime の秒。全セルに日付があれば epoch 秒、全セルに無ければ 1 日内の秒、混在・不正は null。 */
    private static Map<String, Double> acquisitionSeconds(SeriesLayout layout, Map<String, TimeTags> tags) {
        boolean anyDate = false;
        boolean allDate = true;
        for (SeriesLayout.Cell cell : layout.cells()) {
            TimeTags t = tags.get(cell.sopInstanceUid());
            if (t == null) {
                return null;
            }
            boolean has = t.acquisitionDate() != null && !t.acquisitionDate().isBlank();
            anyDate |= has;
            allDate &= has;
        }
        if (anyDate && !allDate) {
            return null;
        }
        final boolean withDate = allDate;
        return perCell(layout, tags, t -> {
            Double tod = parseTimeOfDay(t.acquisitionTime());
            if (tod == null) {
                return null;
            }
            if (!withDate) {
                return tod;
            }
            Long day = parseEpochDay(t.acquisitionDate());
            return day == null ? null : day * 86400.0 + tod;
        });
    }

    /** DICOM TM（HH[MM[SS[.FFFFFF]]]、旧形式の HH:MM:SS も許す）→ 1 日内の秒。壊れた値は null。 */
    static Double parseTimeOfDay(String tm) {
        if (tm == null) {
            return null;
        }
        String s = tm.strip().replace(":", "");
        if (s.length() < 2) {
            return null;
        }
        String intPart = s;
        double frac = 0;
        int dot = s.indexOf('.');
        if (dot >= 0) {
            intPart = s.substring(0, dot);
            String f = s.substring(dot + 1);
            if (!f.isEmpty()) {
                if (!f.chars().allMatch(Character::isDigit) || f.length() > 6) {
                    return null;
                }
                frac = Double.parseDouble("0." + f);
            }
        }
        if (intPart.length() % 2 != 0 || intPart.length() > 6 || !intPart.chars().allMatch(Character::isDigit)) {
            return null;
        }
        int hh = Integer.parseInt(intPart.substring(0, 2));
        int mm = intPart.length() >= 4 ? Integer.parseInt(intPart.substring(2, 4)) : 0;
        int ss = intPart.length() >= 6 ? Integer.parseInt(intPart.substring(4, 6)) : 0;
        if (hh > 23 || mm > 59 || ss > 60) {
            return null;
        }
        return hh * 3600.0 + mm * 60.0 + ss + frac;
    }

    /** DICOM DA（YYYYMMDD）→ epoch day。壊れた値は null。 */
    static Long parseEpochDay(String da) {
        if (da == null) {
            return null;
        }
        String s = da.strip();
        if (s.length() != 8 || !s.chars().allMatch(Character::isDigit)) {
            return null;
        }
        try {
            return LocalDate.of(Integer.parseInt(s.substring(0, 4)), Integer.parseInt(s.substring(4, 6)),
                    Integer.parseInt(s.substring(6, 8))).toEpochDay();
        } catch (java.time.DateTimeException e) {
            return null;
        }
    }

    /** 各 (c,z) の連鎖を t の昇順に並べて値が厳密に増加するか。2 点以上の連鎖が 1 本も無ければ false。 */
    private static boolean strictlyIncreasing(SeriesLayout layout, Map<String, Double> value) {
        Map<Long, List<SeriesLayout.Cell>> chains = new HashMap<>();
        for (SeriesLayout.Cell cell : layout.cells()) {
            chains.computeIfAbsent(((long) cell.c() << 32) | (cell.z() & 0xffffffffL), k -> new ArrayList<>()).add(cell);
        }
        boolean anyPair = false;
        for (List<SeriesLayout.Cell> chain : chains.values()) {
            chain.sort(Comparator.comparingInt(SeriesLayout.Cell::t));
            for (int i = 1; i < chain.size(); i++) {
                anyPair = true;
                if (!(value.get(chain.get(i).sopInstanceUid()) > value.get(chain.get(i - 1).sopInstanceUid()))) {
                    return false;
                }
            }
        }
        return anyPair;
    }

    private static Map<String, Double> zeroBased(Map<String, Double> value) {
        double min = Double.POSITIVE_INFINITY;
        for (double v : value.values()) {
            min = Math.min(min, v);
        }
        Map<String, Double> out = new HashMap<>();
        for (Map.Entry<String, Double> e : value.entrySet()) {
            out.put(e.getKey(), e.getValue() - min);
        }
        return out;
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.roi;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.zip.DataFormatException;
import java.util.zip.Deflater;
import java.util.zip.Inflater;

/**
 * シリーズの統合・分割（インスタンスの SeriesInstanceUID の書き換え）のあと、保存済みの塗り ROI を
 * 新しいシリーズへ付け替える・分ける。
 *
 * <p>塗り ROI のフレームは 1 枚ごとに {@code referencedSopInstanceUid} を持ち、復元は SOP でスライスを決める。
 * SOP は統合・分割で変わらないので、フレームの中身はそのまま使える。直すのは「どのシリーズの行か」だけ。
 * <ul>
 *   <li>元のシリーズのインスタンスが全部出て、行き先が 1 つ: 行の {@code seriesUid} とメタを付け替える（フレームは復号しない）。</li>
 *   <li>それ以外（分割・一部だけ移った統合）: フレームを復号して SOP で振り分け、シリーズごとの行にする。</li>
 * </ul>
 */
@Component
public class RoiMaskSeriesRelocator {

    private static final Logger log = LoggerFactory.getLogger(RoiMaskSeriesRelocator.class);
    /** 展開後の JSON の上限。これを超えるものは分けずに残す（メモリを使い切らない）。 */
    static final long MAX_INFLATED_BYTES = 256L << 20;
    private long maxInflatedBytes = MAX_INFLATED_BYTES;

    public record Result(int repointed, int split, int removed, int unhandled) {
        static final Result NONE = new Result(0, 0, 0, 0);

        Result plus(Result o) {
            return new Result(repointed + o.repointed, split + o.split, removed + o.removed, unhandled + o.unhandled);
        }

        /** 移った・増えた塗り ROI の件数（応答に出す）。 */
        public int moved() {
            return repointed + split;
        }
    }

    private final RoiMaskDocumentRepository masks;
    private final DicomInstanceRepository instances;
    private final ObjectMapper mapper = new ObjectMapper();

    public RoiMaskSeriesRelocator(RoiMaskDocumentRepository masks, DicomInstanceRepository instances) {
        this.masks = masks;
        this.instances = instances;
    }

    /**
     * @param oldSeriesBySop 別シリーズへ移った SOP → 移す前のシリーズ
     * @param newSeriesBySop 同 → 移した後のシリーズ（移していない SOP は含めない）
     */
    public Result relocate(String studyUid, Map<String, String> oldSeriesBySop, Map<String, String> newSeriesBySop) {
        Map<String, Map<String, String>> movesByOld = new LinkedHashMap<>();
        for (var e : oldSeriesBySop.entrySet()) {
            String now = newSeriesBySop.get(e.getKey());
            if (now != null && !now.equals(e.getValue())) {
                movesByOld.computeIfAbsent(e.getValue(), k -> new LinkedHashMap<>()).put(e.getKey(), now);
            }
        }
        Result total = Result.NONE;
        for (var e : movesByOld.entrySet()) {
            String old = e.getKey();
            Map<String, String> moves = e.getValue();
            List<RoiMaskDocument> rows = masks.findBySeriesUidIn(List.of(old));
            if (rows.isEmpty()) {
                continue;
            }
            Set<String> targets = new LinkedHashSet<>(moves.values());
            boolean allLeft = instances.findBySeries(studyUid, old).isEmpty();
            for (RoiMaskDocument row : rows) {
                try {
                    total = total.plus(allLeft && targets.size() == 1
                            ? repoint(row, old, targets.iterator().next())
                            : partition(row, old, moves));
                } catch (IOException | DataFormatException | RuntimeException ex) {
                    log.warn("塗り ROI を新しいシリーズへ移せません（元のまま残します）: mask={} ({})", row.getMaskUid(),
                            ex.toString());
                    total = total.plus(new Result(0, 0, 0, 1));
                }
            }
        }
        if (total.moved() + total.removed() + total.unhandled() > 0) {
            log.info("塗り ROI をシリーズの変更に合わせました: study={} {}", studyUid, total);
        }
        return total;
    }

    /** テスト用（大きすぎる塗り ROI を分けずに残す動作を、小さな上限で確かめる）。 */
    public void setMaxInflatedBytes(long v) {
        this.maxInflatedBytes = v;
    }

    private Result repoint(RoiMaskDocument row, String old, String target) throws IOException {
        row.update(target, write(metaFor(row.getMeta(), old, target, null)), row.getFrames(), row.getFrameCount());
        masks.save(row);
        return new Result(1, 0, 0, 0);
    }

    private Result partition(RoiMaskDocument row, String old, Map<String, String> moves)
            throws IOException, DataFormatException {
        byte[] json = inflate(row.getFrames(), maxInflatedBytes);
        if (json == null) {
            log.warn("塗り ROI の展開が大きすぎるため分けません: mask={}", row.getMaskUid());
            return new Result(0, 0, 0, 1);
        }
        JsonNode root = mapper.readTree(json);
        if (!root.path("segments").isArray()) {
            throw new IOException("frames の形が違います");
        }
        // 行き先ごとの 出力（rows/columns と、フレームがあるセグメントだけ）
        Map<String, ObjectNode> out = new LinkedHashMap<>();
        Map<String, Set<Integer>> segNumbers = new LinkedHashMap<>();
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (JsonNode seg : root.path("segments")) {
            Map<String, ArrayNode> framesByTarget = new LinkedHashMap<>();
            for (JsonNode fr : seg.path("frames")) {
                String sop = fr.path("referencedSopInstanceUid").asText("");
                String t = sop.isEmpty() ? old : moves.getOrDefault(sop, old);
                framesByTarget.computeIfAbsent(t, k -> mapper.createArrayNode()).add(fr);
            }
            for (var fe : framesByTarget.entrySet()) {
                ObjectNode o = out.computeIfAbsent(fe.getKey(), k -> {
                    ObjectNode n = mapper.createObjectNode();
                    n.set("rows", root.get("rows"));
                    n.set("columns", root.get("columns"));
                    n.set("segments", mapper.createArrayNode());
                    return n;
                });
                ObjectNode s = mapper.createObjectNode(); // frames の画素を複製しない（振り分けた配列を載せる）
                seg.fields().forEachRemaining(f -> {
                    if (!f.getKey().equals("frames")) {
                        s.set(f.getKey(), f.getValue());
                    }
                });
                s.set("frames", fe.getValue());
                ((ArrayNode) o.get("segments")).add(s);
                segNumbers.computeIfAbsent(fe.getKey(), k -> new LinkedHashSet<>()).add(seg.path("number").asInt());
                counts.merge(fe.getKey(), fe.getValue().size(), Integer::sum);
            }
        }
        if (out.isEmpty() || (out.size() == 1 && out.containsKey(old))) {
            return Result.NONE; // 動いた SOP のフレームが無い（この塗り ROI は元のシリーズのまま）
        }
        boolean keepsOld = out.containsKey(old);
        int repointed = 0;
        int created = 0;
        boolean rowReused = false;
        for (var e : out.entrySet()) {
            String t = e.getKey();
            byte[] frames = deflate(mapper.writeValueAsBytes(e.getValue()));
            String meta = write(metaFor(row.getMeta(), old, t, segNumbers.get(t)));
            if (t.equals(old) || (!keepsOld && !rowReused)) {
                row.update(t, meta, frames, counts.get(t)); // maskUid を保つ（元のシリーズに残る分、無ければ最初の行き先）
                masks.save(row);
                rowReused = true;
                if (!t.equals(old)) {
                    repointed++;
                }
            } else {
                masks.save(new RoiMaskDocument(UUID.randomUUID().toString(), row.getPatientKey(), t, meta, frames,
                        counts.get(t)));
                created++;
            }
        }
        return new Result(repointed, created, 0, 0);
    }

    /**
     * メタの {@code origin/scope.seriesUid} を新しいシリーズへ。{@code z} が数値（旧スタックのスライス番号）なら
     * 付け替え後は意味が変わるので {@code "all"} にする。{@code keepSegments} があれば、その番号のセグメントだけ残す。
     */
    private ObjectNode metaFor(String metaJson, String old, String target, Set<Integer> keepSegments)
            throws IOException {
        JsonNode parsed = mapper.readTree(metaJson);
        if (!(parsed instanceof ObjectNode meta)) {
            throw new IOException("meta の形が違います");
        }
        for (String k : List.of("origin", "scope")) {
            if (meta.get(k) instanceof ObjectNode sc) {
                if (old.equals(sc.path("seriesUid").asText(""))) {
                    sc.put("seriesUid", target);
                }
                if (sc.path("z").isNumber()) {
                    sc.put("z", "all");
                }
            }
        }
        if (keepSegments != null) {
            if (meta.get("segments") instanceof ArrayNode segs) {
                List<JsonNode> kept = new ArrayList<>();
                segs.forEach(n -> {
                    if (keepSegments.contains(n.asInt())) {
                        kept.add(n);
                    }
                });
                segs.removeAll();
                kept.forEach(segs::add);
            }
            if (meta.get("segmentLabels") instanceof ObjectNode labels) {
                List<String> drop = new ArrayList<>();
                labels.fieldNames().forEachRemaining(f -> {
                    if (!keepSegments.contains(parseIntOr(f, Integer.MIN_VALUE))) {
                        drop.add(f);
                    }
                });
                labels.remove(drop);
            }
        }
        return meta;
    }

    private static int parseIntOr(String s, int fallback) {
        try {
            return Integer.parseInt(s);
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private String write(JsonNode n) throws IOException {
        return mapper.writeValueAsString(n);
    }

    /** deflate-raw を展開する。上限を超えたら null。 */
    static byte[] inflate(byte[] data, long max) throws DataFormatException {
        Inflater inf = new Inflater(true);
        try {
            inf.setInput(data);
            ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(1024, data.length * 4));
            byte[] buf = new byte[1 << 16];
            while (!inf.finished()) {
                int n = inf.inflate(buf);
                if (n == 0 && (inf.needsInput() || inf.needsDictionary())) {
                    break;
                }
                bos.write(buf, 0, n);
                if (bos.size() > max) {
                    return null;
                }
            }
            return bos.toByteArray();
        } finally {
            inf.end();
        }
    }

    static byte[] deflate(byte[] data) {
        Deflater def = new Deflater(Deflater.DEFAULT_COMPRESSION, true);
        try {
            def.setInput(data);
            def.finish();
            ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(1024, data.length / 4));
            byte[] buf = new byte[1 << 16];
            while (!def.finished()) {
                bos.write(buf, 0, def.deflate(buf));
            }
            return bos.toByteArray();
        } finally {
            def.end();
        }
    }
}

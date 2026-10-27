/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.vis.graphynext.dicom.DicomPhantomFactory;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.roi.RoiMaskDocument;
import com.vis.graphynext.roi.RoiMaskDocumentRepository;
import com.vis.graphynext.roi.RoiMaskSeriesRelocator;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import java.util.zip.Deflater;
import java.util.zip.Inflater;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * シリーズの統合・分割のあと、保存済みの塗り ROI が新しいシリーズへ追従する（フレームは SOP で持つので中身は不変）。
 * 負例（動かさないもの）を必ず見る。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.NONE,
        properties = {
                "spring.datasource.url=jdbc:h2:mem:maskrelocate;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class MaskSeriesRelocateTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("store").toString());
    }

    @Autowired
    DbAdminService dbAdmin;
    @Autowired
    DicomStorageService storage;
    @Autowired
    RoiMaskDocumentRepository masks;
    @Autowired
    RoiMaskSeriesRelocator relocator;

    private final ObjectMapper mapper = new ObjectMapper();

    private void ingest(String pid, String study, String series, String sop) throws Exception {
        Attributes ds = DicomPhantomFactory.scImage(pid, study, series, sop);
        ds.setString(Tag.PatientName, VR.PN, pid + "^N");
        storage.ingest(DicomPhantomFactory.writeFile(Files.createTempFile("ph", ".dcm"), ds, UID.ExplicitVRLittleEndian));
    }

    private static String meta(String pk, String study, String series, String zJson, String segs) {
        return "{\"patientKey\":\"" + pk + "\",\"label\":\"ROI\",\"origin\":{\"studyUid\":\"" + study
                + "\",\"seriesUid\":\"" + series + "\",\"z\":" + zJson + "},\"scope\":{\"studyUid\":\"" + study
                + "\",\"seriesUid\":\"" + series + "\",\"z\":" + zJson + "},\"segments\":" + segs
                + ",\"segmentLabels\":{\"1\":\"A\",\"2\":\"B\"}}";
    }

    /** segs: 番号 → そのセグメントのフレームの SOP（null は SOP なし）。 */
    private byte[] frames(Map<Integer, List<String>> segs, boolean withVolume) throws Exception {
        ObjectNode root = mapper.createObjectNode();
        root.put("rows", 2).put("columns", 2);
        if (withVolume) {
            root.put("volumeMm3", 12.5).put("depthSource", "ipp");
        }
        ArrayNode sa = root.putArray("segments");
        for (var e : segs.entrySet()) {
            ObjectNode s = sa.addObject();
            s.put("number", e.getKey()).put("label", e.getKey() == 1 ? "A" : "B");
            ArrayNode fa = s.putArray("frames");
            for (String sop : e.getValue()) {
                ObjectNode f = fa.addObject();
                if (sop != null) {
                    f.put("referencedSopInstanceUid", sop);
                } else {
                    f.putNull("referencedSopInstanceUid");
                }
                f.putNull("imagePositionPatient");
                f.put("mask", "AQID" + e.getKey() + (sop == null ? "x" : sop));
            }
        }
        Deflater d = new Deflater(Deflater.DEFAULT_COMPRESSION, true);
        d.setInput(mapper.writeValueAsBytes(root));
        d.finish();
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        while (!d.finished()) {
            bos.write(buf, 0, d.deflate(buf));
        }
        d.end();
        return bos.toByteArray();
    }

    private JsonNode decode(byte[] b) throws Exception {
        Inflater inf = new Inflater(true);
        inf.setInput(b);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        while (!inf.finished()) {
            int n = inf.inflate(buf);
            if (n == 0 && inf.needsInput()) {
                break;
            }
            bos.write(buf, 0, n);
        }
        inf.end();
        return mapper.readTree(bos.toByteArray());
    }

    private void save(String uid, String pk, String study, String series, String zJson, String segsJson,
                      Map<Integer, List<String>> segs) throws Exception {
        byte[] fr = frames(segs, true);
        int n = segs.values().stream().mapToInt(List::size).sum();
        masks.save(new RoiMaskDocument(uid, pk, series, meta(pk, study, series, zJson, segsJson), fr, n));
    }

    private Set<String> sopsOf(RoiMaskDocument m, int segNo) throws Exception {
        Set<String> out = new TreeSet<>();
        for (JsonNode s : decode(m.getFrames()).path("segments")) {
            if (s.path("number").asInt() == segNo) {
                s.path("frames").forEach(f -> out.add(f.path("referencedSopInstanceUid").asText("")));
            }
        }
        return out;
    }

    private List<RoiMaskDocument> rows(String pk) {
        return masks.findByPatientKey(pk).stream().sorted(java.util.Comparator.comparing(RoiMaskDocument::getSeriesUid)).toList();
    }

    @Test
    void 統合_元のシリーズの塗りROIは統合先へ付く_フレームは不変_統合に入れないシリーズは動かない() throws Exception {
        for (String s : List.of("a", "b", "c")) {
            ingest("MR1", "mr1.st", "mr1." + s, "mr1." + s + ".1");
            ingest("MR1", "mr1.st", "mr1." + s, "mr1." + s + ".2");
        }
        save("ma1", "MR1", "mr1.st", "mr1.a", "3", "[1]", Map.of(1, List.of("mr1.a.1", "mr1.a.2")));
        save("mb1", "MR1", "mr1.st", "mr1.b", "\"all\"", "[1]", Map.of(1, List.of("mr1.b.2")));
        save("mc1", "MR1", "mr1.st", "mr1.c", "\"all\"", "[1]", Map.of(1, List.of("mr1.c.1")));
        byte[] before = masks.findById("ma1").orElseThrow().getFrames().clone();

        var r = dbAdmin.mergeSeries("mr1.st", List.of("mr1.a", "mr1.b"), "mr1.merged", 9, "M");

        assertEquals(2, r.masksMoved());
        RoiMaskDocument a = masks.findById("ma1").orElseThrow();
        assertEquals("mr1.merged", a.getSeriesUid());
        assertEquals("mr1.merged", mapper.readTree(a.getMeta()).path("origin").path("seriesUid").asText());
        assertEquals("mr1.merged", mapper.readTree(a.getMeta()).path("scope").path("seriesUid").asText());
        assertEquals("all", mapper.readTree(a.getMeta()).path("origin").path("z").asText(), "数値の z は意味が変わるので all にする");
        assertArrayEquals(before, a.getFrames(), "付け替えだけでフレームは触らない");
        assertEquals("mr1.merged", masks.findById("mb1").orElseThrow().getSeriesUid());
        assertEquals("mr1.c", masks.findById("mc1").orElseThrow().getSeriesUid(), "統合に入れないシリーズの塗り ROI は動かさない");
    }

    @Test
    void 統合先を元のシリーズの_1_つに指定_その行は不変で_他だけ付け替わる() throws Exception {
        for (String s : List.of("a", "b")) {
            ingest("MR2", "mr2.st", "mr2." + s, "mr2." + s + ".1");
        }
        save("ma2", "MR2", "mr2.st", "mr2.a", "\"all\"", "[1]", Map.of(1, List.of("mr2.a.1")));
        save("mb2", "MR2", "mr2.st", "mr2.b", "\"all\"", "[1]", Map.of(1, List.of("mr2.b.1")));
        Long va = masks.findById("ma2").orElseThrow().getVersion();

        dbAdmin.mergeSeries("mr2.st", List.of("mr2.a", "mr2.b"), "mr2.a", null, null);

        assertEquals("mr2.a", masks.findById("mb2").orElseThrow().getSeriesUid());
        RoiMaskDocument a = masks.findById("ma2").orElseThrow();
        assertEquals("mr2.a", a.getSeriesUid());
        assertEquals(va, a.getVersion(), "動いていない行は書き換えない");
    }

    @Test
    void 分割_塗りROIは新しいシリーズごとに分かれ_元に残るフレームは元の行に残る() throws Exception {
        for (int i = 1; i <= 4; i++) {
            ingest("MR3", "mr3.st", "mr3.s", "mr3.s." + i);
        }
        save("m3", "MR3", "mr3.st", "mr3.s", "2", "[1,2]", Map.of(
                1, List.of("mr3.s.1", "mr3.s.2", "mr3.s.3", "mr3.s.4"), 2, List.of("mr3.s.1", "mr3.s.3")));

        var r = dbAdmin.splitSeries("mr3.st", "mr3.s", List.of(
                new DbAdminService.SplitGroup(List.of("mr3.s.1", "mr3.s.2"), null, null),
                new DbAdminService.SplitGroup(List.of("mr3.s.3"), null, null)));

        assertEquals(2, r.masksMoved(), "新しい 2 行が増えた");
        List<RoiMaskDocument> all = rows("MR3");
        assertEquals(3, all.size());
        RoiMaskDocument orig = masks.findById("m3").orElseThrow();
        assertEquals("mr3.s", orig.getSeriesUid(), "元のシリーズに残る SOP があるので元の行は元のシリーズのまま");
        assertEquals(Set.of("mr3.s.4"), sopsOf(orig, 1));
        assertEquals(Set.of(), sopsOf(orig, 2), "残りにセグメント 2 のフレームは無い");
        assertEquals("[1]", mapper.readTree(orig.getMeta()).path("segments").toString());
        assertEquals("{\"1\":\"A\"}", mapper.readTree(orig.getMeta()).path("segmentLabels").toString());
        assertEquals(1, orig.getFrameCount());

        String g1 = r.newSeriesUids().get(0);
        String g2 = r.newSeriesUids().get(1);
        RoiMaskDocument m1 = all.stream().filter(x -> x.getSeriesUid().equals(g1)).findFirst().orElseThrow();
        RoiMaskDocument m2 = all.stream().filter(x -> x.getSeriesUid().equals(g2)).findFirst().orElseThrow();
        assertEquals(Set.of("mr3.s.1", "mr3.s.2"), sopsOf(m1, 1));
        assertEquals(Set.of("mr3.s.1"), sopsOf(m1, 2));
        assertEquals(Set.of("mr3.s.3"), sopsOf(m2, 1));
        assertEquals(Set.of("mr3.s.3"), sopsOf(m2, 2));
        assertEquals(3, m1.getFrameCount());
        assertEquals(2, m2.getFrameCount());
        assertEquals(6, all.stream().mapToInt(RoiMaskDocument::getFrameCount).sum(), "フレームの合計は分割の前後で等しい");
        assertEquals(g1, mapper.readTree(m1.getMeta()).path("origin").path("seriesUid").asText());
        assertEquals("all", mapper.readTree(m1.getMeta()).path("scope").path("z").asText());
        assertTrue(decode(m1.getFrames()).path("volumeMm3").isMissingNode(), "派生値は分けた側に持ち越さない");
    }

    @Test
    void 分割で元のシリーズのインスタンスが全部出たら_元の行を最初の行き先に使い回す() throws Exception {
        for (int i = 1; i <= 2; i++) {
            ingest("MR4", "mr4.st", "mr4.s", "mr4.s." + i);
        }
        save("m4", "MR4", "mr4.st", "mr4.s", "\"all\"", "[1]", Map.of(1, List.of("mr4.s.1", "mr4.s.2")));

        var r = dbAdmin.splitSeries("mr4.st", "mr4.s", List.of(
                new DbAdminService.SplitGroup(List.of("mr4.s.1"), null, null),
                new DbAdminService.SplitGroup(List.of("mr4.s.2"), null, null)));

        List<RoiMaskDocument> all = rows("MR4");
        assertEquals(2, all.size());
        assertEquals(Set.copyOf(r.newSeriesUids()), all.stream().map(RoiMaskDocument::getSeriesUid).collect(Collectors.toSet()));
        assertTrue(masks.findById("m4").isPresent(), "maskUid は最初の行き先の行が引き継ぐ");
        assertEquals(2, all.stream().mapToInt(RoiMaskDocument::getFrameCount).sum());
    }

    @Test
    void 動いたSOPのフレームが無い塗りROIとSOPの無いフレームは元の行のまま() throws Exception {
        for (int i = 1; i <= 3; i++) {
            ingest("MR5", "mr5.st", "mr5.s", "mr5.s." + i);
        }
        save("stay5", "MR5", "mr5.st", "mr5.s", "\"all\"", "[1]", Map.of(1, List.of("mr5.s.3")));
        save("nosop5", "MR5", "mr5.st", "mr5.s", "\"all\"", "[1]", Map.of(1, java.util.Arrays.asList("mr5.s.1", null)));
        Long v = masks.findById("stay5").orElseThrow().getVersion();

        dbAdmin.splitSeries("mr5.st", "mr5.s", List.of(new DbAdminService.SplitGroup(List.of("mr5.s.1"), null, null)));

        RoiMaskDocument stay = masks.findById("stay5").orElseThrow();
        assertEquals("mr5.s", stay.getSeriesUid());
        assertEquals(v, stay.getVersion(), "動かない塗り ROI は書き換えない");
        RoiMaskDocument nosop = masks.findById("nosop5").orElseThrow();
        assertEquals("mr5.s", nosop.getSeriesUid(), "SOP の無いフレームは元のシリーズに残る");
        assertEquals(1, nosop.getFrameCount());
        assertEquals(3, rows("MR5").size(), "SOP 1 のフレームは新しいシリーズの行になる");
    }

    @Test
    void 展開が大きすぎる塗りROIは分けずに残し_件数に数える() throws Exception {
        for (int i = 1; i <= 2; i++) {
            ingest("MR6", "mr6.st", "mr6.s", "mr6.s." + i);
        }
        save("big6", "MR6", "mr6.st", "mr6.s", "\"all\"", "[1]", Map.of(1, List.of("mr6.s.1", "mr6.s.2")));
        byte[] before = masks.findById("big6").orElseThrow().getFrames().clone();
        relocator.setMaxInflatedBytes(10);
        try {
            var r = dbAdmin.splitSeries("mr6.st", "mr6.s", List.of(new DbAdminService.SplitGroup(List.of("mr6.s.1"), null, null)));
            assertEquals(0, r.masksMoved());
        } finally {
            relocator.setMaxInflatedBytes(256L << 20);
        }
        RoiMaskDocument big = masks.findById("big6").orElseThrow();
        assertEquals("mr6.s", big.getSeriesUid());
        assertArrayEquals(before, big.getFrames());
        assertEquals(1, rows("MR6").size());
    }
}

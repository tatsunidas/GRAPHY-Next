/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.vis.graphynext.dbtransfer.RelatedData;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.plugin.store.PluginDocument;
import com.vis.graphynext.plugin.store.PluginDocumentId;
import com.vis.graphynext.plugin.store.PluginDocumentRepository;
import com.vis.graphynext.registration.RegistrationDocument;
import com.vis.graphynext.registration.RegistrationDocumentRepository;
import com.vis.graphynext.report.Report;
import com.vis.graphynext.report.ReportRepository;
import com.vis.graphynext.roi.RoiDocument;
import com.vis.graphynext.roi.RoiDocumentRepository;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Predicate;

/**
 * 患者の情報を編集して患者キー（{@link RelatedData#patientKey}: PatientID → PatientName → StudyUID）が
 * 変わったとき、そのキーで引く記録（ROI・位置合わせ・プラグインの記録）とレポートの患者 ID を運ぶ。
 *
 * <p>元のキーの検査がすべて移ったときは記録をまるごと、一部だけのときはその検査の分だけを移す
 * （ROI・位置合わせは 1 件ごとに検査の UID を持つので分けられる。プラグインの記録は中身が分からない
 * ので、一部だけのときは動かさない）。移し先にすでに記録があれば<b>上書きしない</b>:
 * ROI は roiUid、位置合わせは記録そのもので重ね合わせ、重なった分は移し先を残して件数を返す。
 *
 * <p>JSON は必要な項目（{@code rois} / {@code deleted} / {@code analyses} / {@code records}）だけを読み書きし、
 * 知らない項目と最上位の値（schema・writer など）は移し先のものを保つ。
 */
@Component
public class PatientRecordMover {

    public record Result(int roisMoved, int roiOverlaps, int registrationsMoved, int pluginDocsMoved,
                         int pluginDocsKept, int reportsUpdated) {
        static final Result NONE = new Result(0, 0, 0, 0, 0, 0);

        Result plus(Result o) {
            return new Result(roisMoved + o.roisMoved, roiOverlaps + o.roiOverlaps,
                    registrationsMoved + o.registrationsMoved, pluginDocsMoved + o.pluginDocsMoved,
                    pluginDocsKept + o.pluginDocsKept, reportsUpdated + o.reportsUpdated);
        }
    }

    private final DicomInstanceRepository repo;
    private final RoiDocumentRepository rois;
    private final RegistrationDocumentRepository registrations;
    private final PluginDocumentRepository plugins;
    private final ReportRepository reports;
    private final ObjectMapper mapper = new ObjectMapper();

    public PatientRecordMover(DicomInstanceRepository repo, RoiDocumentRepository rois,
                              RegistrationDocumentRepository registrations, PluginDocumentRepository plugins,
                              ReportRepository reports) {
        this.repo = repo;
        this.rois = rois;
        this.registrations = registrations;
        this.plugins = plugins;
        this.reports = reports;
    }

    /** 編集の前に、行ごとの元のキーを控える（SOP → キー）。 */
    public static Map<String, String> keysBefore(List<DicomInstance> rows) {
        Map<String, String> m = new LinkedHashMap<>();
        rows.forEach(r -> m.put(r.getSopInstanceUid(), RelatedData.patientKey(r)));
        return m;
    }

    /**
     * 編集のあとに呼ぶ（rows は新しい値に書き換え済み・同じトランザクション）。
     *
     * @param newPatientId PatientID を変えたとき新しい値（変えないなら null）。レポートの患者 ID に使う
     */
    public Result afterEdit(List<DicomInstance> rows, Map<String, String> before, String newPatientId) {
        // (元のキー → 新しいキー) ごとに、動いた検査と SOP をまとめる
        Map<List<String>, Set<String>> studies = new LinkedHashMap<>();
        Map<List<String>, Set<String>> sops = new LinkedHashMap<>();
        Set<String> editedStudies = new LinkedHashSet<>();
        for (DicomInstance r : rows) {
            editedStudies.add(r.getStudyInstanceUid());
            String from = before.get(r.getSopInstanceUid());
            String to = RelatedData.patientKey(r);
            if (from == null || from.equals(to)) {
                continue;
            }
            List<String> k = List.of(from, to);
            studies.computeIfAbsent(k, x -> new LinkedHashSet<>()).add(r.getStudyInstanceUid());
            sops.computeIfAbsent(k, x -> new HashSet<>()).add(r.getSopInstanceUid());
        }
        repo.flush(); // 「元のキーの検査が残っているか」を新しい値で問い合わせるため
        Result total = Result.NONE;
        for (var e : studies.entrySet()) {
            String from = e.getKey().get(0);
            String to = e.getKey().get(1);
            boolean whole = !remains(from);
            total = total.plus(moveRois(from, to, whole, e.getValue(), sops.get(e.getKey())));
            total = total.plus(moveRegistrations(from, to, whole, e.getValue()));
            total = total.plus(movePlugins(from, to, whole));
        }
        if (newPatientId != null) {
            int n = 0;
            for (String s : editedStudies) {
                for (Report rep : reports.findByStudyInstanceUidOrderByCreatedAtDesc(s)) {
                    if (!newPatientId.equals(rep.getPatientId())) {
                        rep.setPatientId(newPatientId);
                        reports.save(rep);
                        n++;
                    }
                }
            }
            total = total.plus(new Result(0, 0, 0, 0, 0, n));
        }
        return total;
    }

    /** そのキーの検査が DB に残っているか。PatientID 由来のキーなら ID で引き、それ以外は全件から探す。 */
    private boolean remains(String key) {
        if (!repo.findByPatientId(key).isEmpty()) {
            return true;
        }
        return repo.findAll().stream().anyMatch(i -> key.equals(RelatedData.patientKey(i)));
    }

    private Result moveRois(String from, String to, boolean whole, Set<String> studyUids, Set<String> sopUids) {
        RoiDocument src = rois.findById(from).orElse(null);
        if (src == null) {
            return Result.NONE;
        }
        ObjectNode s = parse(src.getJson());
        Predicate<JsonNode> roiMoves = whole ? n -> true : n -> {
            String st = n.path("studyUid").asText("");
            return st.isEmpty() ? sopUids.contains(n.path("sopInstanceUid").asText("")) : studyUids.contains(st);
        };
        Predicate<JsonNode> analysisMoves = whole ? n -> true : n -> studyUids.contains(n.path("studyUid").asText(""));
        ArrayNode movingRois = take(s, "rois", roiMoves);
        ArrayNode movingAnalyses = take(s, "analyses", analysisMoves);
        if (movingRois.isEmpty() && movingAnalyses.isEmpty()) {
            return Result.NONE;
        }
        RoiDocument dst = rois.findById(to).orElse(null);
        ObjectNode d = dst == null ? s.deepCopy().removeAll() : parse(dst.getJson());
        if (dst == null) {
            copyTopLevel(s, d);
        }
        int overlaps = union(d, "rois", movingRois, "roiUid");
        union(d, "analyses", movingAnalyses, "pickUid");
        union(d, "deleted", array(s, "deleted"), "roiUid"); // 消した ROI が移し先で生き返らないように
        save(dst, to, d);
        if (whole) {
            rois.delete(src);
        } else {
            src.update(write(s), array(s, "rois").size());
            rois.save(src);
        }
        return new Result(movingRois.size() - overlaps, overlaps, 0, 0, 0, 0);
    }

    private void save(RoiDocument dst, String key, ObjectNode d) {
        if (dst == null) {
            rois.save(new RoiDocument(key, write(d), array(d, "rois").size()));
        } else {
            dst.update(write(d), array(d, "rois").size());
            rois.save(dst);
        }
    }

    private Result moveRegistrations(String from, String to, boolean whole, Set<String> studyUids) {
        RegistrationDocument src = registrations.findById(from).orElse(null);
        if (src == null) {
            return Result.NONE;
        }
        ObjectNode s = parse(src.getJson());
        ArrayNode moving = take(s, "records", whole ? n -> true : n ->
                studyUids.contains(n.path("fixed").path("studyInstanceUid").asText(""))
                        || studyUids.contains(n.path("moving").path("studyInstanceUid").asText("")));
        if (moving.isEmpty()) {
            return Result.NONE;
        }
        RegistrationDocument dst = registrations.findById(to).orElse(null);
        ObjectNode d = dst == null ? s.deepCopy().removeAll() : parse(dst.getJson());
        if (dst == null) {
            copyTopLevel(s, d);
        }
        ArrayNode target = array(d, "records");
        int added = 0;
        for (JsonNode r : moving) {
            if (!contains(target, r)) {
                target.add(r);
                added++;
            }
        }
        d.set("records", target);
        if (dst == null) {
            registrations.save(new RegistrationDocument(to, write(d), target.size()));
        } else {
            dst.update(write(d), target.size());
            registrations.save(dst);
        }
        if (whole) {
            registrations.delete(src);
        } else {
            src.update(write(s), array(s, "records").size());
            registrations.save(src);
        }
        return new Result(0, 0, added, 0, 0, 0);
    }

    private Result movePlugins(String from, String to, boolean whole) {
        List<PluginDocument> docs = plugins.findAll().stream().filter(p -> from.equals(p.getId().getPatientKey()))
                .toList();
        int moved = 0;
        int kept = 0;
        for (PluginDocument p : docs) {
            if (!whole || plugins.existsById(new PluginDocumentId(p.getId().getPluginId(), to))) {
                kept++;
                continue;
            }
            plugins.save(new PluginDocument(p.getId().getPluginId(), to, p.getJson()));
            plugins.delete(p);
            moved++;
        }
        return new Result(0, 0, 0, moved, kept, 0);
    }

    /** obj[field] のうち条件に合う要素を取り出して返し、obj には残りを入れ直す。 */
    private static ArrayNode take(ObjectNode obj, String field, Predicate<JsonNode> moves) {
        ArrayNode all = array(obj, field);
        ArrayNode out = all.arrayNode();
        ArrayNode rest = all.arrayNode();
        all.forEach(n -> (moves.test(n) ? out : rest).add(n));
        if (obj.has(field)) {
            obj.set(field, rest);
        }
        return out;
    }

    /** 識別子が重ならないものだけ足す。重なった件数を返す（移し先を残す）。 */
    private static int union(ObjectNode target, String field, ArrayNode incoming, String idField) {
        if (incoming.isEmpty()) {
            return 0;
        }
        ArrayNode arr = array(target, field);
        Set<String> ids = new HashSet<>();
        arr.forEach(n -> ids.add(n.path(idField).asText("")));
        int overlaps = 0;
        for (JsonNode n : incoming) {
            String id = n.path(idField).asText("");
            if (!id.isEmpty() && ids.contains(id)) {
                overlaps++;
            } else {
                arr.add(n);
                ids.add(id);
            }
        }
        target.set(field, arr);
        return overlaps;
    }

    private static boolean contains(ArrayNode arr, JsonNode n) {
        for (JsonNode x : arr) {
            if (Objects.equals(x, n)) {
                return true;
            }
        }
        return false;
    }

    private static void copyTopLevel(ObjectNode from, ObjectNode to) {
        from.fields().forEachRemaining(e -> {
            if (!e.getValue().isArray()) {
                to.set(e.getKey(), e.getValue());
            }
        });
    }

    private static ArrayNode array(ObjectNode obj, String field) {
        JsonNode n = obj.get(field);
        return n != null && n.isArray() ? ((ArrayNode) n).deepCopy() : obj.arrayNode();
    }

    private ObjectNode parse(String json) {
        try {
            JsonNode n = mapper.readTree(json == null || json.isBlank() ? "{}" : json);
            return n instanceof ObjectNode o ? o : mapper.createObjectNode();
        } catch (IOException e) {
            throw new UncheckedIOException("患者の記録（JSON）を読めません", e);
        }
    }

    private String write(ObjectNode n) {
        try {
            return mapper.writeValueAsString(n);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}

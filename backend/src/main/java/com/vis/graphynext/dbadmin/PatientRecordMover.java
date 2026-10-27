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
import com.vis.graphynext.radiomics.GlamAnalysisDocument;
import com.vis.graphynext.radiomics.GlamAnalysisDocumentRepository;
import com.vis.graphynext.plugin.store.PluginDocumentId;
import com.vis.graphynext.plugin.store.PluginDocumentRepository;
import com.vis.graphynext.registration.RegistrationDocument;
import com.vis.graphynext.registration.RegistrationDocumentRepository;
import com.vis.graphynext.report.Report;
import com.vis.graphynext.report.ReportRepository;
import com.vis.graphynext.roi.RoiDocument;
import com.vis.graphynext.roi.RoiDocumentRepository;
import com.vis.graphynext.roi.RoiMaskDocument;
import com.vis.graphynext.roi.RoiMaskDocumentRepository;
import com.vis.graphynext.settings.SettingsService;
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
                         int pluginDocsKept, int reportsUpdated, int masksMoved) {
        static final Result NONE = new Result(0, 0, 0, 0, 0, 0, 0);

        Result plus(Result o) {
            return new Result(roisMoved + o.roisMoved, roiOverlaps + o.roiOverlaps,
                    registrationsMoved + o.registrationsMoved, pluginDocsMoved + o.pluginDocsMoved,
                    pluginDocsKept + o.pluginDocsKept, reportsUpdated + o.reportsUpdated,
                    masksMoved + o.masksMoved);
        }
    }

    private final DicomInstanceRepository repo;
    private final RoiDocumentRepository rois;
    private final RoiMaskDocumentRepository masks;
    private final RegistrationDocumentRepository registrations;
    private final PluginDocumentRepository plugins;
    private final ReportRepository reports;
    private final GlamAnalysisDocumentRepository glam;
    private final SettingsService settings;
    private final ObjectMapper mapper = new ObjectMapper();

    public PatientRecordMover(DicomInstanceRepository repo, RoiDocumentRepository rois, RoiMaskDocumentRepository masks,
                              RegistrationDocumentRepository registrations, PluginDocumentRepository plugins,
                              ReportRepository reports, GlamAnalysisDocumentRepository glam, SettingsService settings) {
        this.repo = repo;
        this.rois = rois;
        this.masks = masks;
        this.registrations = registrations;
        this.plugins = plugins;
        this.reports = reports;
        this.glam = glam;
        this.settings = settings;
    }

    /** 画像を削除したあとに片付けた付随データの件数。レポートは数えない（レポートは画像を消しても残す）。 */
    public record Cleanup(int roisRemoved, int analysesRemoved, int registrationsRemoved, int calibrationsRemoved,
                          int glamRemoved, int pluginDocsRemoved, int masksRemoved) {
    }

    /**
     * 画像（行）を削除したあとに呼ぶ（同じトランザクション・行は削除済み）。消えた画像に結び付いていた付随データを消す。
     *
     * <ul>
     *   <li>ROI・解析状態: 消えた SOP を指すもの。</li>
     *   <li>塗り ROI（マスク）: 消えたシリーズのもの。患者の画像がすべて消えたときは、その患者のものをすべて。</li>
     *   <li>位置合わせ・XA 校正: 消えたシリーズ（DB に 1 枚も残っていない）を指すもの。</li>
     *   <li>GLAM: 消えた検査のもの、または元のシリーズ・マスクが消えたシリーズのもの。</li>
     *   <li>患者の画像がすべて消えたとき: その患者キーの ROI・位置合わせの文書とプラグインの記録をまるごと。</li>
     * </ul>
     * 🔴 レポートには触れない。レポートは画像とは別に管理し、消すのはレポート機能からだけ。
     */
    public Cleanup afterDelete(List<DicomInstance> deleted) {
        if (deleted.isEmpty()) {
            return new Cleanup(0, 0, 0, 0, 0, 0, 0);
        }
        repo.flush();
        Set<String> sops = new HashSet<>();
        Map<String, Set<String>> seriesByStudy = new LinkedHashMap<>();
        Set<String> keys = new LinkedHashSet<>();
        for (DicomInstance r : deleted) {
            sops.add(r.getSopInstanceUid());
            seriesByStudy.computeIfAbsent(r.getStudyInstanceUid(), x -> new LinkedHashSet<>()).add(r.getSeriesInstanceUid());
            keys.add(RelatedData.patientKey(r));
        }
        Set<String> goneStudies = new LinkedHashSet<>();
        Set<String> goneSeries = new LinkedHashSet<>();
        for (var e : seriesByStudy.entrySet()) {
            if (repo.countByStudyInstanceUid(e.getKey()) == 0) {
                goneStudies.add(e.getKey());
            }
            for (String se : e.getValue()) {
                if (repo.countByStudyInstanceUidAndSeriesInstanceUid(e.getKey(), se) == 0) {
                    goneSeries.add(se);
                }
            }
        }
        int roisRemoved = 0;
        int analysesRemoved = 0;
        int regsRemoved = 0;
        int pluginsRemoved = 0;
        // 塗り ROI は画素を持つ別テーブル。消えたシリーズのものを消す（シリーズ UID は一意）。
        int masksRemoved = goneSeries.isEmpty() ? 0 : (int) masks.deleteBySeriesUidIn(goneSeries);
        for (String key : keys) {
            boolean patientGone = !remains(key);
            if (patientGone) {
                masksRemoved += (int) masks.deleteByPatientKey(key);
            }
            RoiDocument roi = rois.findById(key).orElse(null);
            if (roi != null) {
                ObjectNode d = parse(roi.getJson());
                if (patientGone) {
                    roisRemoved += array(d, "rois").size();
                    analysesRemoved += array(d, "analyses").size();
                    rois.delete(roi);
                } else {
                    int r = take(d, "rois", n -> sops.contains(n.path("sopInstanceUid").asText(""))).size();
                    int a = take(d, "analyses", n -> sops.contains(n.path("sopInstanceUid").asText(""))).size();
                    if (r + a > 0) {
                        roi.update(write(d), array(d, "rois").size());
                        rois.save(roi);
                    }
                    roisRemoved += r;
                    analysesRemoved += a;
                }
            }
            RegistrationDocument reg = registrations.findById(key).orElse(null);
            if (reg != null) {
                ObjectNode d = parse(reg.getJson());
                if (patientGone) {
                    regsRemoved += array(d, "records").size();
                    registrations.delete(reg);
                } else {
                    int n = take(d, "records", x ->
                            goneSeries.contains(x.path("fixed").path("seriesInstanceUid").asText(""))
                                    || goneSeries.contains(x.path("moving").path("seriesInstanceUid").asText(""))).size();
                    if (n > 0) {
                        reg.update(write(d), array(d, "records").size());
                        registrations.save(reg);
                    }
                    regsRemoved += n;
                }
            }
            if (patientGone) {
                List<PluginDocument> docs = plugins.findAll().stream()
                        .filter(p -> key.equals(p.getId().getPatientKey())).toList();
                plugins.deleteAll(docs);
                pluginsRemoved += docs.size();
            }
        }
        int calib = settings.deleteKeys(goneSeries.stream().map(RelatedData::calibrationKey).toList());
        int glamRemoved = 0;
        for (String study : seriesByStudy.keySet()) {
            List<GlamAnalysisDocument> hit = glam.findByStudyInstanceUidOrderBySavedAtDesc(study).stream()
                    .filter(g -> goneStudies.contains(study) || goneSeries.contains(g.getSourceSeriesUid())
                            || (g.getMaskSeriesUid() != null && goneSeries.contains(g.getMaskSeriesUid())))
                    .toList();
            glam.deleteAll(hit);
            glamRemoved += hit.size();
        }
        return new Cleanup(roisRemoved, analysesRemoved, regsRemoved, calib, glamRemoved, pluginsRemoved, masksRemoved);
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
            total = total.plus(moveMasks(from, to, whole, e.getValue()));
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
            total = total.plus(new Result(0, 0, 0, 0, 0, n, 0));
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
        return new Result(movingRois.size() - overlaps, overlaps, 0, 0, 0, 0, 0);
    }

    /**
     * 塗り ROI の行を新しい患者キーへ付け替える。全部移るとき（{@code whole}）は元のキーの全部、一部の検査だけのときは、
     * メタの検査 UID（原本 {@code origin}、無ければ {@code scope}）が動いた検査のものだけ。
     * 行の患者キーとメタ JSON の患者キーを両方書き換える（復元はメタの患者キーも見るため）。画素・シリーズは変えない。
     */
    private Result moveMasks(String from, String to, boolean whole, Set<String> studyUids) {
        int moved = 0;
        for (RoiMaskDocument m : masks.findByPatientKey(from)) {
            ObjectNode meta = parse(m.getMeta());
            if (!whole) {
                String st = meta.path("origin").path("studyUid").asText("");
                if (st.isEmpty()) {
                    st = meta.path("scope").path("studyUid").asText("");
                }
                if (!studyUids.contains(st)) {
                    continue;
                }
            }
            meta.put("patientKey", to);
            m.moveTo(to, write(meta));
            masks.save(m);
            moved++;
        }
        return moved == 0 ? Result.NONE : new Result(0, 0, 0, 0, 0, 0, moved);
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
        return new Result(0, 0, added, 0, 0, 0, 0);
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
        return new Result(0, 0, 0, moved, kept, 0, 0);
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

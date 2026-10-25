/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin.retention;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.plugin.store.PluginDocumentRepository;
import com.vis.graphynext.radiomics.GlamAnalysisDocumentRepository;
import com.vis.graphynext.registration.RegistrationDocumentRepository;
import com.vis.graphynext.report.ReportRepository;
import com.vis.graphynext.roi.RoiDocumentRepository;
import com.vis.graphynext.settings.SettingsService;
import org.dcm4che3.data.UID;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Collection;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 自動削除の対象から外す検査と、その理由を集める。判定のたびに全件を読み直す（キャッシュしない）。
 *
 * <p>ROI・位置合わせ・プラグインの記録は患者単位の文書なので、中身を読んで検査（SOP・シリーズ）に結び付ける。
 * プラグインの記録は中身を解釈できず検査に割り当てられないので、その患者の検査をすべて守る。
 */
@Component
public class RetentionProtections {

    /** SQL の IN 句に渡す件数の上限（巨大な IN を避ける）。 */
    private static final int CHUNK = 500;

    /**
     * 通常の画像でない DICOM の SOP クラス。本体が作る派生物（セグメンテーション・RT・構造化レポート・表示状態・
     * キーオブジェクト・パラメトリックマップ）を含む検査を守る。<b>線量 SR（X-Ray Radiation Dose SR）は含めない</b>
     * （スキャナが毎回付けるので、含めるとほとんどの CT が保護になる）。二次キャプチャ画像も含めない（同様に外部から
     * 普通に来る）。派生シリーズが元と同じモダリティの画像として保存された場合は、この判定では見分けられない
     * （受信 DICOM と区別する印が索引に無いため。必要なら別の仕組みで印を付ける）。
     */
    static final List<String> NON_IMAGE_SOP_CLASSES = List.of(
            UID.SegmentationStorage,
            UID.RTStructureSetStorage,
            UID.RTPlanStorage,
            UID.RTDoseStorage,
            UID.ParametricMapStorage,
            UID.ComprehensiveSRStorage,
            UID.GrayscaleSoftcopyPresentationStateStorage,
            UID.KeyObjectSelectionDocumentStorage);

    private final DicomInstanceRepository instances;
    private final StudyRetentionHoldRepository holds;
    private final ReportRepository reports;
    private final GlamAnalysisDocumentRepository glam;
    private final RoiDocumentRepository rois;
    private final RegistrationDocumentRepository registrations;
    private final PluginDocumentRepository plugins;
    private final SettingsService settings;
    private final InUseRegistry inUse;
    private final ObjectMapper mapper = new ObjectMapper();

    public RetentionProtections(DicomInstanceRepository instances, StudyRetentionHoldRepository holds,
                                ReportRepository reports, GlamAnalysisDocumentRepository glam,
                                RoiDocumentRepository rois, RegistrationDocumentRepository registrations,
                                PluginDocumentRepository plugins, SettingsService settings, InUseRegistry inUse) {
        this.instances = instances;
        this.holds = holds;
        this.reports = reports;
        this.glam = glam;
        this.rois = rois;
        this.registrations = registrations;
        this.plugins = plugins;
        this.settings = settings;
        this.inUse = inUse;
    }

    /** 与えた検査のうち、保護の理由があるもの（受信日時に関わる理由は {@link RetentionPlanner} が足す）。 */
    @Transactional(readOnly = true)
    public Map<String, Set<ProtectionReason>> collect(List<StudyStat> studies) {
        Set<String> known = new HashSet<>();
        for (StudyStat s : studies) {
            known.add(s.studyUid());
        }
        Map<String, Set<ProtectionReason>> out = new LinkedHashMap<>();

        holds.findAll().forEach(h -> add(out, known, h.getStudyInstanceUid(), ProtectionReason.LOCK));
        reports.studiesWithReports().forEach(s -> add(out, known, s, ProtectionReason.REPORT));
        glam.studiesWithAnalyses().forEach(s -> add(out, known, s, ProtectionReason.GLAM));
        inUse.snapshot().forEach(s -> add(out, known, s, ProtectionReason.IN_USE));

        // ROI・解析状態: SOP → 検査
        Set<String> sops = new HashSet<>();
        rois.findAll().forEach(d -> {
            JsonNode root = parse(d.getJson());
            for (String arr : List.of("rois", "analyses")) {
                for (JsonNode n : root.path(arr)) {
                    String sop = n.path("sopInstanceUid").asText("");
                    if (!sop.isEmpty()) {
                        sops.add(sop);
                    }
                }
            }
        });
        studiesOf(sops, instances::studiesOfSops).forEach(s -> add(out, known, s, ProtectionReason.ROI));

        // 位置合わせ: シリーズ → 検査
        Set<String> series = new HashSet<>();
        registrations.findAll().forEach(d -> {
            for (JsonNode n : parse(d.getJson()).path("records")) {
                for (String side : List.of("fixed", "moving")) {
                    String se = n.path(side).path("seriesInstanceUid").asText("");
                    if (!se.isEmpty()) {
                        series.add(se);
                    }
                }
            }
        });
        studiesOf(series, instances::studiesOfSeries).forEach(s -> add(out, known, s, ProtectionReason.REGISTRATION));

        // XA 校正: キーのシリーズ → 検査
        Set<String> calSeries = new HashSet<>();
        for (String k : settings.getAll().keySet()) {
            if (k.startsWith(SettingsService.XA_CALIBRATION_PREFIX)) {
                calSeries.add(k.substring(SettingsService.XA_CALIBRATION_PREFIX.length()));
            }
        }
        studiesOf(calSeries, instances::studiesOfSeries).forEach(s -> add(out, known, s, ProtectionReason.XA_CALIBRATION));

        // プラグインの記録がある患者の検査をすべて
        Set<String> pluginKeys = new HashSet<>();
        plugins.findAll().forEach(p -> pluginKeys.add(p.getId().getPatientKey()));
        for (StudyStat s : studies) {
            if (pluginKeys.contains(s.patientKey())) {
                add(out, known, s.studyUid(), ProtectionReason.PLUGIN_RECORD);
            }
        }

        // 通常の画像でない DICOM を含む検査
        instances.studiesWithSopClasses(NON_IMAGE_SOP_CLASSES).forEach(s -> add(out, known, s, ProtectionReason.NON_IMAGE_DICOM));
        return out;
    }

    private static void add(Map<String, Set<ProtectionReason>> out, Set<String> known, String study, ProtectionReason r) {
        if (study != null && known.contains(study)) {
            out.computeIfAbsent(study, k -> EnumSet.noneOf(ProtectionReason.class)).add(r);
        }
    }

    private static List<String> studiesOf(Collection<String> keys, java.util.function.Function<List<String>, List<String>> q) {
        List<String> all = new ArrayList<>(keys);
        List<String> out = new ArrayList<>();
        for (int i = 0; i < all.size(); i += CHUNK) {
            out.addAll(q.apply(all.subList(i, Math.min(all.size(), i + CHUNK))));
        }
        return out;
    }

    /** 壊れた文書は例外にする（読めないまま「保護なし」にして消してしまわない）。 */
    private JsonNode parse(String json) {
        try {
            return mapper.readTree(json == null || json.isBlank() ? "{}" : json);
        } catch (Exception e) {
            throw new IllegalStateException("保護の判定のため読んだ文書の JSON が壊れています", e);
        }
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbtransfer;

import com.vis.graphynext.dbtransfer.TransferManifest.GlamItem;
import com.vis.graphynext.dbtransfer.TransferManifest.KeyImageItem;
import com.vis.graphynext.dbtransfer.TransferManifest.ParticipantItem;
import com.vis.graphynext.dbtransfer.TransferManifest.PatientDocItem;
import com.vis.graphynext.dbtransfer.TransferManifest.PluginDocItem;
import com.vis.graphynext.dbtransfer.TransferManifest.Related;
import com.vis.graphynext.dbtransfer.TransferManifest.ReportItem;
import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.plugin.store.PluginDocument;
import com.vis.graphynext.plugin.store.PluginDocumentRepository;
import com.vis.graphynext.radiomics.GlamAnalysisDocument;
import com.vis.graphynext.radiomics.GlamAnalysisDocumentRepository;
import com.vis.graphynext.registration.RegistrationDocument;
import com.vis.graphynext.registration.RegistrationDocumentRepository;
import com.vis.graphynext.report.KeyImageRef;
import com.vis.graphynext.report.ParticipationType;
import com.vis.graphynext.report.Report;
import com.vis.graphynext.report.ReportParticipant;
import com.vis.graphynext.report.ReportRepository;
import com.vis.graphynext.report.ReportStatus;
import com.vis.graphynext.report.ReportType;
import com.vis.graphynext.report.StaffRole;
import com.vis.graphynext.roi.RoiDocument;
import com.vis.graphynext.roi.RoiDocumentRepository;
import com.vis.graphynext.settings.SettingsService;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * 検査に付随するデータ（レポート・GLAM・XA 校正・患者単位の ROI／位置合わせ／プラグイン文書）を
 * 荷物に詰める・荷物から取り込む・移動のあと移し元から消す。
 *
 * <p>取り込みは<b>上書きしない</b>。移し先に同じキーがあり中身が違えば「衝突」として返し、呼び出し側が
 * {@code inbox/conflicts/} に残す。同じ中身ならそのまま飛ばす（中断後のやり直しで衝突扱いにしない）。
 */
@Component
public class RelatedData {

    private final ReportRepository reports;
    private final GlamAnalysisDocumentRepository glam;
    private final RoiDocumentRepository rois;
    private final RegistrationDocumentRepository registrations;
    private final PluginDocumentRepository plugins;
    private final SettingsService settings;

    public RelatedData(ReportRepository reports, GlamAnalysisDocumentRepository glam, RoiDocumentRepository rois,
                       RegistrationDocumentRepository registrations, PluginDocumentRepository plugins,
                       SettingsService settings) {
        this.reports = reports;
        this.glam = glam;
        this.rois = rois;
        this.registrations = registrations;
        this.plugins = plugins;
        this.settings = settings;
    }

    /** ROI などの鍵（フロントの derivePatientKey と同じ: PatientID → PatientName → StudyInstanceUID）。 */
    public static String patientKey(DicomInstance i) {
        if (i.getPatientId() != null && !i.getPatientId().isEmpty()) {
            return i.getPatientId();
        }
        if (i.getPatientName() != null && !i.getPatientName().isEmpty()) {
            return i.getPatientName();
        }
        return i.getStudyInstanceUid();
    }

    public static String calibrationKey(String seriesUid) {
        return SettingsService.XA_CALIBRATION_PREFIX + seriesUid;
    }

    @Transactional(readOnly = true)
    public Related collect(Collection<String> studyUids, Collection<String> seriesUids, Collection<String> patientKeys) {
        List<ReportItem> rep = new ArrayList<>();
        List<GlamItem> gl = new ArrayList<>();
        for (String s : studyUids) {
            reports.findByStudyInstanceUidOrderByCreatedAtDesc(s).forEach(r -> rep.add(toItem(r)));
            glam.findByStudyInstanceUidOrderBySavedAtDesc(s).forEach(g -> gl.add(new GlamItem(g.getId(),
                    g.getStudyInstanceUid(), g.getSourceSeriesUid(), g.getMaskSeriesUid(), g.getLabel(), g.getJson(),
                    g.getNBins(), g.getMaxRadius(), g.getRoiVoxelCount(), str(g.getSavedAt()))));
        }
        Map<String, String> all = settings.getAll();
        Map<String, String> cal = new LinkedHashMap<>();
        for (String se : seriesUids) {
            String k = calibrationKey(se);
            if (all.containsKey(k)) {
                cal.put(k, all.get(k));
            }
        }
        List<PatientDocItem> roi = new ArrayList<>();
        List<PatientDocItem> reg = new ArrayList<>();
        for (String pk : patientKeys) {
            rois.findById(pk).ifPresent(d -> roi.add(new PatientDocItem(pk, d.getJson(), d.getRoiCount())));
            registrations.findById(pk).ifPresent(d -> reg.add(new PatientDocItem(pk, d.getJson(), d.getRecordCount())));
        }
        List<PluginDocItem> pl = new ArrayList<>();
        Set<String> keys = Set.copyOf(patientKeys);
        for (PluginDocument d : plugins.findAll()) {
            if (keys.contains(d.getId().getPatientKey())) {
                pl.add(new PluginDocItem(d.getId().getPluginId(), d.getId().getPatientKey(), d.getJson()));
            }
        }
        return new Related(rep, gl, cal, roi, reg, pl);
    }

    /** 取り込みの結果。conflicts は種類とキー、実体（呼び出し側がファイルに残す）。 */
    public record ApplyResult(int inserted, int same, List<Conflict> conflicts) {
    }

    public record Conflict(String kind, String key, Object incoming) {
    }

    @Transactional
    public ApplyResult apply(Related rel) {
        int inserted = 0;
        int same = 0;
        List<Conflict> conflicts = new ArrayList<>();
        for (ReportItem r : nz(rel.reports())) {
            var cur = reports.findById(r.id());
            if (cur.isEmpty()) {
                reports.save(fromItem(r));
                inserted++;
            } else if (Objects.equals(str(cur.get().getUpdatedAt()), r.updatedAt())) {
                same++;
            } else {
                conflicts.add(new Conflict("report", r.id(), r));
            }
        }
        for (GlamItem g : nz(rel.glam())) {
            var cur = glam.findById(g.id());
            if (cur.isEmpty()) {
                GlamAnalysisDocument d = new GlamAnalysisDocument(g.id(), g.studyInstanceUid(), g.sourceSeriesUid(),
                        g.maskSeriesUid(), g.label(), g.json(), g.nBins(), g.maxRadius(), g.roiVoxelCount());
                if (g.savedAt() != null) {
                    d.setSavedAt(Instant.parse(g.savedAt()));
                }
                glam.save(d);
                inserted++;
            } else if (Objects.equals(cur.get().getJson(), g.json())) {
                same++;
            } else {
                conflicts.add(new Conflict("glam", g.id(), g));
            }
        }
        if (rel.calibrations() != null && !rel.calibrations().isEmpty()) {
            Map<String, String> all = settings.getAll();
            Map<String, String> put = new LinkedHashMap<>();
            for (var e : rel.calibrations().entrySet()) {
                if (!all.containsKey(e.getKey())) {
                    put.put(e.getKey(), e.getValue());
                    inserted++;
                } else if (Objects.equals(all.get(e.getKey()), e.getValue())) {
                    same++;
                } else {
                    conflicts.add(new Conflict("calibration", e.getKey(), Map.of(e.getKey(), e.getValue())));
                }
            }
            if (!put.isEmpty()) {
                settings.putAll(put);
            }
        }
        for (PatientDocItem d : nz(rel.rois())) {
            var cur = rois.findById(d.patientKey());
            if (cur.isEmpty()) {
                rois.save(new RoiDocument(d.patientKey(), d.json(), d.count()));
                inserted++;
            } else if (Objects.equals(cur.get().getJson(), d.json())) {
                same++;
            } else {
                conflicts.add(new Conflict("roi", d.patientKey(), d));
            }
        }
        for (PatientDocItem d : nz(rel.registrations())) {
            var cur = registrations.findById(d.patientKey());
            if (cur.isEmpty()) {
                registrations.save(new RegistrationDocument(d.patientKey(), d.json(), d.count()));
                inserted++;
            } else if (Objects.equals(cur.get().getJson(), d.json())) {
                same++;
            } else {
                conflicts.add(new Conflict("registration", d.patientKey(), d));
            }
        }
        for (PluginDocItem d : nz(rel.plugins())) {
            var cur = plugins.findById(new com.vis.graphynext.plugin.store.PluginDocumentId(d.pluginId(), d.patientKey()));
            if (cur.isEmpty()) {
                plugins.save(new PluginDocument(d.pluginId(), d.patientKey(), d.json()));
                inserted++;
            } else if (Objects.equals(cur.get().getJson(), d.json())) {
                same++;
            } else {
                conflicts.add(new Conflict("plugin", d.pluginId() + "/" + d.patientKey(), d));
            }
        }
        return new ApplyResult(inserted, same, conflicts);
    }

    /**
     * 移動のあと移し元から消す。患者単位の文書は、その患者の検査が移し元に残っていないときだけ消す
     * （一部の検査だけ移したときはコピーに留める）。
     */
    @Transactional
    public void deleteAfterMove(Collection<String> studyUids, Collection<String> seriesUids,
                                Collection<String> patientKeysWithoutStudies) {
        for (String s : studyUids) {
            reports.deleteAll(reports.findByStudyInstanceUidOrderByCreatedAtDesc(s));
            glam.deleteAll(glam.findByStudyInstanceUidOrderBySavedAtDesc(s));
        }
        settings.deleteKeys(seriesUids.stream().map(RelatedData::calibrationKey).toList());
        for (String pk : patientKeysWithoutStudies) {
            rois.findById(pk).ifPresent(rois::delete);
            registrations.findById(pk).ifPresent(registrations::delete);
            plugins.deleteAll(plugins.findAll().stream().filter(d -> pk.equals(d.getId().getPatientKey())).toList());
        }
    }

    private static ReportItem toItem(Report r) {
        List<ParticipantItem> ps = r.getParticipants().stream().map(p -> new ParticipantItem(p.getId(), p.getName(),
                name(p.getStaffRole()), name(p.getParticipationType()), p.getOrganization(),
                str(p.getParticipatedAt()))).toList();
        List<KeyImageItem> ks = r.getKeyImages().stream().map(k -> new KeyImageItem(k.getId(), k.getSopInstanceUid(),
                k.getSeriesInstanceUid(), k.getFrameNumber(), k.getLabel(), k.getAnnotation(), k.getSortOrder()))
                .toList();
        return new ReportItem(r.getId(), r.getPatientId(), r.getStudyInstanceUid(), r.getSeriesInstanceUid(),
                r.getTitle(), name(r.getReportType()), name(r.getStatus()), r.getBodyMarkdown(),
                r.getClinicalHistory(), r.getReferringPhysician(), r.getSrSopInstanceUid(), r.getKoSopInstanceUid(),
                r.getKoSeriesInstanceUid(), r.getPredecessorReportId(), r.getPredecessorSrSopUid(),
                str(r.getCreatedAt()), str(r.getUpdatedAt()), ps, ks);
    }

    /** 編集ロック（lockedBy/At）は運ばない。移し先では誰も編集していない。 */
    private static Report fromItem(ReportItem i) {
        Report r = new Report(i.id());
        r.setPatientId(i.patientId());
        r.setStudyInstanceUid(i.studyInstanceUid());
        r.setSeriesInstanceUid(i.seriesInstanceUid());
        r.setTitle(i.title());
        r.setReportType(i.reportType() == null ? null : ReportType.valueOf(i.reportType()));
        r.setStatus(i.status() == null ? null : ReportStatus.valueOf(i.status()));
        r.setBodyMarkdown(i.bodyMarkdown());
        r.setClinicalHistory(i.clinicalHistory());
        r.setReferringPhysician(i.referringPhysician());
        r.setSrSopInstanceUid(i.srSopInstanceUid());
        r.setKoSopInstanceUid(i.koSopInstanceUid());
        r.setKoSeriesInstanceUid(i.koSeriesInstanceUid());
        r.setPredecessorReportId(i.predecessorReportId());
        r.setPredecessorSrSopUid(i.predecessorSrSopUid());
        r.setCreatedAt(instant(i.createdAt()));
        r.setUpdatedAt(instant(i.updatedAt()));
        for (ParticipantItem p : nz(i.participants())) {
            ReportParticipant rp = new ReportParticipant(p.id(), p.name(),
                    p.staffRole() == null ? null : StaffRole.valueOf(p.staffRole()),
                    p.participationType() == null ? null : ParticipationType.valueOf(p.participationType()),
                    p.organization());
            rp.setParticipatedAt(instant(p.participatedAt()));
            r.addParticipant(rp);
        }
        for (KeyImageItem k : nz(i.keyImages())) {
            r.addKeyImage(new KeyImageRef(k.id(), k.sopInstanceUid(), k.seriesInstanceUid(), k.frameNumber(),
                    k.label(), k.annotation(), k.sortOrder()));
        }
        return r;
    }

    private static <T> List<T> nz(List<T> l) {
        return l == null ? List.of() : l;
    }

    private static String name(Enum<?> e) {
        return e == null ? null : e.name();
    }

    private static String str(Instant t) {
        return t == null ? null : t.toString();
    }

    private static Instant instant(String s) {
        return s == null ? null : Instant.parse(s);
    }
}

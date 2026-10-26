/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.dcm4che3.net.Status;
import org.dcm4che3.net.service.DicomServiceException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * C-FIND の検索本体。ローカル索引（H2）から候補を作り、{@link DicomMatcher} で絞る。
 *
 * <p>レベルは上から順に絞り込む（スタディ→シリーズ→画像）。下のレベルの候補には上のレベルの属性
 * （PatientID・StudyDate など）も載せるので、下のレベルの問い合わせでも上位の属性を戻せ、
 * 上位のキーでも絞れる。重い下位の問い合わせ（画像）は、上位で残ったものだけについて索引を引く。
 * 索引に無い属性（StudyTime・StudyID など）は候補に載せない＝キーは無視、戻りは空。
 */
@Service
public class DicomFindQuery {

    private static final Logger log = LoggerFactory.getLogger(DicomFindQuery.class);

    private static final int IN_CHUNK = 500;

    private enum Level {
        PATIENT, STUDY, SERIES, IMAGE
    }

    private final DicomInstanceRepository repo;

    public DicomFindQuery(DicomInstanceRepository repo) {
        this.repo = repo;
    }

    /**
     * @param patientRoot true=Patient Root、false=Study Root
     * @param keys        要求の Identifier（QueryRetrieveLevel を含む）
     * @return 一致した行。{@code keys} に含まれる属性だけを戻す形に整えるのは呼び出し側（{@link DicomFindScp}）。
     */
    public List<Attributes> find(boolean patientRoot, Attributes keys) throws DicomServiceException {
        Level target = level(keys, patientRoot);
        Set<String> patientIds = null;

        if (patientRoot) {
            List<Attributes> patients = new ArrayList<>();
            for (DicomInstanceRepository.PatientSummary p : repo.findPatientSummaries(null, false)) {
                Attributes a = patientAttrs(p.getPatientId(), p.getPatientName(), p.getPatientBirthDate(), p.getPatientSex());
                a.setInt(Tag.NumberOfPatientRelatedStudies, VR.IS, (int) p.getNumberOfStudies());
                a.setInt(Tag.NumberOfPatientRelatedInstances, VR.IS, (int) p.getNumberOfInstances());
                patients.add(a);
            }
            List<Attributes> matched = filter(keys, patients);
            if (target == Level.PATIENT) {
                return matched;
            }
            patientIds = new HashSet<>();
            for (Attributes a : matched) {
                patientIds.add(a.getString(Tag.PatientID, ""));
            }
        }

        List<Attributes> studies = studies(keys, patientIds);
        if (target == Level.STUDY) {
            return studies;
        }

        List<Attributes> series = new ArrayList<>();
        for (Attributes st : studies) {
            for (DicomInstanceRepository.SeriesSummary s : repo.findSeriesSummaries(st.getString(Tag.StudyInstanceUID))) {
                Attributes a = new Attributes(st);
                put(a, Tag.SeriesInstanceUID, VR.UI, s.getSeriesInstanceUid());
                put(a, Tag.Modality, VR.CS, s.getModality());
                putInt(a, Tag.SeriesNumber, s.getSeriesNumber());
                put(a, Tag.SeriesDescription, VR.LO, s.getSeriesDescription());
                a.setInt(Tag.NumberOfSeriesRelatedInstances, VR.IS, (int) s.getNumberOfInstances());
                series.add(a);
            }
        }
        series = filter(keys, series);
        if (target == Level.SERIES) {
            return series;
        }

        List<Attributes> images = new ArrayList<>();
        for (Attributes se : series) {
            for (DicomInstance i : repo.findBySeries(se.getString(Tag.StudyInstanceUID), se.getString(Tag.SeriesInstanceUID))) {
                Attributes a = new Attributes(se);
                put(a, Tag.SOPInstanceUID, VR.UI, i.getSopInstanceUid());
                put(a, Tag.SOPClassUID, VR.UI, i.getSopClassUid());
                putInt(a, Tag.InstanceNumber, i.getInstanceNumber());
                putInt(a, Tag.NumberOfFrames, i.getNumberOfFrames());
                images.add(a);
            }
        }
        return filter(keys, images);
    }

    private List<Attributes> studies(Attributes keys, Set<String> patientIds) {
        List<DicomInstanceRepository.StudyHeader> headers = new ArrayList<>();
        for (DicomInstanceRepository.StudyHeader h : repo.findStudyHeaders()) {
            if (patientIds == null || patientIds.contains(h.getPatientId() == null ? "" : h.getPatientId())) {
                headers.add(h);
            }
        }
        // ModalitiesInStudy は引くのに追加の問い合わせが要るので、キーに含まれるときだけ用意する。
        boolean wantModalities = keys.contains(Tag.ModalitiesInStudy);
        Map<String, Set<String>> modalities = new HashMap<>();
        if (wantModalities) {
            List<String> uids = headers.stream().map(DicomInstanceRepository.StudyHeader::getStudyInstanceUid).toList();
            for (int from = 0; from < uids.size(); from += IN_CHUNK) {
                List<String> chunk = uids.subList(from, Math.min(uids.size(), from + IN_CHUNK));
                for (DicomInstanceRepository.StudyModality m : repo.findStudyModalities(chunk)) {
                    modalities.computeIfAbsent(m.getStudyUid(), k -> new LinkedHashSet<>()).add(m.getModality());
                }
            }
        }
        List<Attributes> out = new ArrayList<>(headers.size());
        for (DicomInstanceRepository.StudyHeader h : headers) {
            Attributes a = patientAttrs(h.getPatientId(), h.getPatientName(), h.getPatientBirthDate(), h.getPatientSex());
            put(a, Tag.StudyInstanceUID, VR.UI, h.getStudyInstanceUid());
            put(a, Tag.StudyDate, VR.DA, h.getStudyDate());
            put(a, Tag.StudyDescription, VR.LO, h.getStudyDescription());
            put(a, Tag.AccessionNumber, VR.SH, h.getAccessionNumber());
            a.setInt(Tag.NumberOfStudyRelatedSeries, VR.IS, (int) h.getNumberOfSeries());
            a.setInt(Tag.NumberOfStudyRelatedInstances, VR.IS, (int) h.getNumberOfInstances());
            if (wantModalities) {
                Set<String> m = modalities.get(h.getStudyInstanceUid());
                if (m == null || m.isEmpty()) {
                    a.setNull(Tag.ModalitiesInStudy, VR.CS);
                } else {
                    a.setString(Tag.ModalitiesInStudy, VR.CS, m.toArray(String[]::new));
                }
            }
            out.add(a);
        }
        return filter(keys, out);
    }

    private static List<Attributes> filter(Attributes keys, List<Attributes> candidates) {
        List<Attributes> out = new ArrayList<>();
        for (Attributes c : candidates) {
            if (DicomMatcher.matches(keys, c)) {
                out.add(c);
            }
        }
        if (log.isDebugEnabled() && !candidates.isEmpty()) {
            String ignored = DicomMatcher.ignoredKeys(keys, candidates.get(0));
            if (!ignored.isEmpty()) {
                log.debug("C-FIND: 索引に無い属性のキーは無視しました: {}", ignored);
            }
        }
        return out;
    }

    private static Level level(Attributes keys, boolean patientRoot) throws DicomServiceException {
        String v = keys.getString(Tag.QueryRetrieveLevel);
        if (v == null) {
            throw new DicomServiceException(Status.IdentifierDoesNotMatchSOPClass, "QueryRetrieveLevel がありません");
        }
        Level l;
        try {
            l = Level.valueOf(v.trim());
        } catch (IllegalArgumentException e) {
            throw new DicomServiceException(Status.IdentifierDoesNotMatchSOPClass,
                    "QueryRetrieveLevel が不正です: " + v);
        }
        if (l == Level.PATIENT && !patientRoot) {
            throw new DicomServiceException(Status.IdentifierDoesNotMatchSOPClass,
                    "Study Root では PATIENT レベルを問い合わせられません");
        }
        return l;
    }

    private static Attributes patientAttrs(String id, String name, String birth, String sex) {
        Attributes a = new Attributes();
        put(a, Tag.PatientID, VR.LO, id);
        put(a, Tag.PatientName, VR.PN, name);
        put(a, Tag.PatientBirthDate, VR.DA, birth);
        put(a, Tag.PatientSex, VR.CS, sex);
        return a;
    }

    /** 値が無いときも<b>タグは載せる</b>（索引にある属性で値が空、と、索引に無い属性を区別するため）。 */
    private static void put(Attributes a, int tag, VR vr, String v) {
        if (v == null || v.isEmpty()) {
            a.setNull(tag, vr);
        } else {
            a.setString(tag, vr, v);
        }
    }

    private static void putInt(Attributes a, int tag, Integer v) {
        if (v == null) {
            a.setNull(tag, VR.IS);
        } else {
            a.setInt(tag, VR.IS, v);
        }
    }
}

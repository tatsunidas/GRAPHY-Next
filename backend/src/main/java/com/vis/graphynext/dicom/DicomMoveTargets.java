/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.DicomStorageService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.net.Status;
import org.dcm4che3.net.service.DicomServiceException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * C-MOVE の識別子から、送るインスタンスを索引で引く。検索（C-FIND）と違い、一意キー（UID・PatientID）だけで引く。
 * ワイルドカードは解釈しない（一致しなければ 0 件）。
 */
@Service
public class DicomMoveTargets {

    /** 送る対象。{@code path} が null のものは、索引にあるがファイルが読めない（送信時に失敗として数える）。 */
    public record Target(DicomInstance instance, java.nio.file.Path path) {
    }

    private final DicomInstanceRepository repo;
    private final DicomStorageService storage;

    public DicomMoveTargets(DicomInstanceRepository repo, DicomStorageService storage) {
        this.repo = repo;
        this.storage = storage;
    }

    /**
     * @param patientRoot Patient Root の MOVE か（false なら Study Root）
     * @throws DicomServiceException 識別子が情報モデルに合わない・必須の一意キーが無いとき 0xA900
     */
    @Transactional(readOnly = true)
    public List<Target> resolve(boolean patientRoot, Attributes keys) throws DicomServiceException {
        String level = keys.getString(Tag.QueryRetrieveLevel);
        if (level == null) {
            throw mismatch("QueryRetrieveLevel がありません");
        }
        Map<String, DicomInstance> found = new LinkedHashMap<>();
        switch (level) {
            case "PATIENT" -> {
                if (!patientRoot) {
                    throw mismatch("Study Root では PATIENT レベルの取得はできません");
                }
                for (String pid : required(keys, Tag.PatientID, "PatientID")) {
                    add(found, repo.findByPatientId(pid));
                }
            }
            case "STUDY" -> {
                for (String study : required(keys, Tag.StudyInstanceUID, "StudyInstanceUID")) {
                    add(found, repo.findByStudyInstanceUid(study));
                }
            }
            case "SERIES" -> {
                String study = single(keys, Tag.StudyInstanceUID, "StudyInstanceUID");
                for (String series : required(keys, Tag.SeriesInstanceUID, "SeriesInstanceUID")) {
                    add(found, repo.findBySeries(study, series));
                }
            }
            case "IMAGE" -> {
                String study = optionalSingle(keys, Tag.StudyInstanceUID);
                String series = optionalSingle(keys, Tag.SeriesInstanceUID);
                for (String sop : required(keys, Tag.SOPInstanceUID, "SOPInstanceUID")) {
                    add(found, repo.findMatches(null, study, series, sop));
                }
            }
            default -> throw mismatch("QueryRetrieveLevel " + level + " は取得に対応していません");
        }
        List<DicomInstance> insts = new ArrayList<>(found.values());
        Map<String, java.nio.file.Path> paths = new LinkedHashMap<>();
        for (DicomStorageService.Located l : storage.locate(insts)) {
            paths.put(l.instance().getSopInstanceUid(), l.path());
        }
        List<Target> out = new ArrayList<>(insts.size());
        for (DicomInstance i : insts) {
            out.add(new Target(i, paths.get(i.getSopInstanceUid())));
        }
        return out;
    }

    private static void add(Map<String, DicomInstance> into, List<DicomInstance> from) {
        for (DicomInstance i : from) {
            into.putIfAbsent(i.getSopInstanceUid(), i);
        }
    }

    private static List<String> required(Attributes keys, int tag, String name) throws DicomServiceException {
        String[] v = keys.getStrings(tag);
        List<String> out = new ArrayList<>();
        if (v != null) {
            for (String s : v) {
                if (s != null && !s.isBlank()) {
                    out.add(s.trim());
                }
            }
        }
        if (out.isEmpty()) {
            throw mismatch(name + " がありません");
        }
        return out;
    }

    private static String single(Attributes keys, int tag, String name) throws DicomServiceException {
        List<String> v = required(keys, tag, name);
        if (v.size() != 1) {
            throw mismatch(name + " は 1 つだけ指定してください");
        }
        return v.get(0);
    }

    private static String optionalSingle(Attributes keys, int tag) throws DicomServiceException {
        String[] v = keys.getStrings(tag);
        if (v == null || v.length == 0 || v[0] == null || v[0].isBlank()) {
            return null;
        }
        if (v.length != 1) {
            throw mismatch("UID は 1 つだけ指定してください");
        }
        return v[0].trim();
    }

    private static DicomServiceException mismatch(String message) {
        return new DicomServiceException(Status.IdentifierDoesNotMatchSOPClass, message);
    }
}

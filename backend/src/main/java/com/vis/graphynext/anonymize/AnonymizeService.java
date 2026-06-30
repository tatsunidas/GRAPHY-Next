/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.dcm4che3.io.DicomOutputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * 匿名化（属性＋Pixel 焼き込み）のオーケストレーション。standalone のローカルファイルを読み、
 * 匿名化して ZIP / フォルダへ出力する（web は WADO 取得が必要なため未対応）。
 */
@Service
public class AnonymizeService {

    private static final Logger log = LoggerFactory.getLogger(AnonymizeService.class);

    private static final Set<String> UNCOMPRESSED = Set.of(
            UID.ImplicitVRLittleEndian, UID.ExplicitVRLittleEndian, UID.ExplicitVRBigEndian);

    private final DicomInstanceRepository repo;
    private final AnonymizeMaskStore maskStore;
    private final ObjectProvider<WebDicomDataService> webProvider;
    private final DicomAnonymizerEngine engine = new DicomAnonymizerEngine();

    public AnonymizeService(DicomInstanceRepository repo, AnonymizeMaskStore maskStore,
                            ObjectProvider<WebDicomDataService> webProvider) {
        this.repo = repo;
        this.maskStore = maskStore;
        this.webProvider = webProvider;
    }

    public record Result(int studies, int series, int instances, int burnedInstances, List<String> errors) {
    }

    public boolean isWeb() {
        return webProvider.getIfAvailable() != null;
    }

    /** 匿名化して ZIP ストリームへ出力。 */
    @Transactional(readOnly = true)
    public Result anonymizeToZip(List<String> studyUids, AnonymizeConfig cfg, boolean burnIn, OutputStream out)
            throws IOException {
        try (ZipOutputStream zos = new ZipOutputStream(out)) {
            return run(studyUids, cfg, burnIn, (ds, tsuid) -> {
                String name = ds.getString(Tag.StudyInstanceUID) + "/" + ds.getString(Tag.SeriesInstanceUID)
                        + "/" + ds.getString(Tag.SOPInstanceUID) + ".dcm";
                zos.putNextEntry(new ZipEntry(name));
                writePart10(ds, tsuid, zos);
                zos.closeEntry();
            });
        }
    }

    /** 匿名化してフォルダへ出力（standalone）。 */
    @Transactional(readOnly = true)
    public Result anonymizeToFolder(List<String> studyUids, AnonymizeConfig cfg, boolean burnIn, String destination)
            throws IOException {
        Path dest = Path.of(destination);
        if (!dest.isAbsolute()) {
            throw new IOException("出力先は絶対パスで指定してください: " + destination);
        }
        Files.createDirectories(dest);
        return run(studyUids, cfg, burnIn, (ds, tsuid) -> {
            Path dir = dest.resolve(ds.getString(Tag.StudyInstanceUID)).resolve(ds.getString(Tag.SeriesInstanceUID));
            Files.createDirectories(dir);
            Path f = dir.resolve(ds.getString(Tag.SOPInstanceUID) + ".dcm");
            try (OutputStream fo = Files.newOutputStream(f)) {
                writePart10(ds, tsuid, fo);
            }
        });
    }

    private interface Sink {
        void accept(Attributes anonymized, String tsuid) throws IOException;
    }

    private Result run(List<String> studyUids, AnonymizeConfig cfg, boolean burnIn, Sink sink) {
        List<String> errors = new ArrayList<>();
        // 対象インスタンスを収集し、患者マッピングを事前構築。
        List<DicomInstance> all = new ArrayList<>();
        java.util.Set<String> studySet = new java.util.LinkedHashSet<>();
        java.util.Set<String> seriesSet = new java.util.LinkedHashSet<>();
        for (String su : studyUids) {
            if (su == null || su.isBlank()) {
                continue;
            }
            List<DicomInstance> insts = repo.findByStudyInstanceUid(su);
            all.addAll(insts);
            studySet.add(su);
        }
        Map<String, DicomAnonymizerEngine.PatientMapping> pmap = buildPatientMappings(all, cfg);
        Map<String, String> uidMap = new HashMap<>();
        boolean cleanPixel = cfg.hasOption(AnonymizeConfig.Option.CleanPixelData) && burnIn;

        int instances = 0;
        int burned = 0;
        for (DicomInstance inst : all) {
            try {
                Path src = fileOf(inst);
                if (src == null) {
                    errors.add("ファイル無し: " + inst.getSopInstanceUid());
                    continue;
                }
                Attributes ds;
                String tsuid;
                try (DicomInputStream in = new DicomInputStream(src.toFile())) {
                    in.setIncludeBulkData(IncludeBulkData.YES);
                    in.readFileMetaInformation();
                    ds = in.readDataset(-1, -1);
                    tsuid = in.getTransferSyntax();
                }
                String origPat = inst.getPatientId() == null ? "" : inst.getPatientId();
                DicomAnonymizerEngine.PatientMapping pm = pmap.getOrDefault(origPat,
                        new DicomAnonymizerEngine.PatientMapping(cfg.getReplacePatientId(), cfg.getReplacePatientName()));

                // 焼き込み（属性匿名化前に元 seriesUid で判定）。
                if (cleanPixel) {
                    AnonymizeMaskStore.SeriesMask mask = maskStore.get(inst.getSeriesInstanceUid());
                    if (mask != null && burnInto(ds, tsuid, mask)) {
                        burned++;
                    }
                }
                engine.deidentify(ds, cfg, pm, uidMap);
                seriesSet.add(ds.getString(Tag.SeriesInstanceUID));
                sink.accept(ds, tsuid);
                instances++;
            } catch (Exception e) {
                errors.add(inst.getSopInstanceUid() + ": " + e.getMessage());
            }
        }
        log.info("Anonymize: studies={} instances={} burned={} errors={}", studySet.size(), instances, burned, errors.size());
        return new Result(studySet.size(), seriesSet.size(), instances, burned, errors);
    }

    /** 患者ごとの新 ID/Name を決める（単一→置換文字列、複数→連番。randomSeed で順序撹拌）。 */
    private static Map<String, DicomAnonymizerEngine.PatientMapping> buildPatientMappings(
            List<DicomInstance> all, AnonymizeConfig cfg) {
        java.util.LinkedHashSet<String> pids = new java.util.LinkedHashSet<>();
        for (DicomInstance i : all) {
            pids.add(i.getPatientId() == null ? "" : i.getPatientId());
        }
        List<String> list = new ArrayList<>(pids);
        Collections.sort(list);
        if (cfg.getRandomSeed() != null) {
            Collections.shuffle(list, new Random(cfg.getRandomSeed()));
        }
        String idPrefix = blank(cfg.getReplacePatientId(), "ANON");
        String namePrefix = blank(cfg.getReplacePatientName(), "ANON");
        boolean single = list.size() == 1;
        Map<String, DicomAnonymizerEngine.PatientMapping> map = new LinkedHashMap<>();
        int n = 1;
        for (String orig : list) {
            String newId = single ? idPrefix : String.format("%s%03d", idPrefix, n);
            String newName = single ? namePrefix : namePrefix + "^" + n;
            map.put(orig, new DicomAnonymizerEngine.PatientMapping(newId, newName));
            n++;
        }
        return map;
    }

    /** 矩形領域を 0 で塗り潰す（非圧縮 TS のみ）。塗ったら true。 */
    private static boolean burnInto(Attributes ds, String tsuid, AnonymizeMaskStore.SeriesMask mask)
            throws IOException {
        if (tsuid == null || !UNCOMPRESSED.contains(tsuid)) {
            return false; // 圧縮 TS は未対応
        }
        int rows = ds.getInt(Tag.Rows, 0);
        int cols = ds.getInt(Tag.Columns, 0);
        if (rows <= 0 || cols <= 0) {
            return false;
        }
        int nf = ds.getInt(Tag.NumberOfFrames, 1);
        int bits = ds.getInt(Tag.BitsAllocated, 8);
        int spp = ds.getInt(Tag.SamplesPerPixel, 1);
        int bps = Math.max(1, bits / 8) * spp;
        int frameSize = rows * cols * bps;
        byte[] px = ds.getBytes(Tag.PixelData);
        if (px == null || px.length < frameSize) {
            return false;
        }
        List<Integer> frames = mask.frames();
        boolean allFrames = frames == null || frames.isEmpty();
        boolean any = false;
        for (int f = 0; f < nf; f++) {
            if (!allFrames && !frames.contains(f)) {
                continue;
            }
            int base = f * frameSize;
            for (AnonymizeMaskStore.Rect r : mask.rects()) {
                int x0 = Math.max(0, r.x());
                int y0 = Math.max(0, r.y());
                int x1 = Math.min(cols, r.x() + r.w());
                int y1 = Math.min(rows, r.y() + r.h());
                for (int y = y0; y < y1; y++) {
                    int off = base + (y * cols + x0) * bps;
                    int len = (x1 - x0) * bps;
                    if (off >= 0 && off + len <= px.length) {
                        java.util.Arrays.fill(px, off, off + len, (byte) 0);
                        any = true;
                    }
                }
            }
        }
        if (any) {
            ds.setBytes(Tag.PixelData, bits > 8 ? VR.OW : VR.OB, px);
        }
        return any;
    }

    private static void writePart10(Attributes ds, String tsuid, OutputStream out) throws IOException {
        String ts = (tsuid == null || tsuid.isBlank()) ? UID.ExplicitVRLittleEndian : tsuid;
        Attributes fmi = ds.createFileMetaInformation(ts);
        DicomOutputStream dos = new DicomOutputStream(out, ts);
        dos.writeDataset(fmi, ds);
        dos.flush();
    }

    private static Path fileOf(DicomInstance inst) {
        String uri = inst.getUri();
        if (uri == null || !uri.startsWith("file:")) {
            return null;
        }
        try {
            Path p = Path.of(java.net.URI.create(uri));
            return Files.exists(p) ? p : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String blank(String s, String fb) {
        return (s == null || s.isBlank()) ? fb : s;
    }
}

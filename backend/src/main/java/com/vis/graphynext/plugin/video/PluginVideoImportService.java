/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.video;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.nondicom.FfmpegLocator;
import com.vis.graphynext.nondicom.VideoConverter;
import com.vis.graphynext.plugin.PluginJobService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CancellationException;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * プラグインのための<b>動画の取り込み</b>（host API の H47 / H48 / H49）。
 *
 * <h3>本体が書く</h3>
 * 「DICOM はプラグインに書かせない」（H4b / H9 / H37 と同じ方針）。プラグインが渡すのは
 * 元の動画のパス・患者の指定・説明文・フレームごとの値だけで、変換・DICOM の組み立て・UID・
 * 患者属性・出所（{@code [Plugin] }・ContributingEquipment）は本体が決める。
 *
 * <h3>重複を止める</h3>
 * 動画の SOP / Series UID は元ファイルの SHA-256 から決める（{@link VideoProbe#uidFrom}）。
 * 同じファイルは患者が違っても取り込まない（{@code duplicate} を返す）。
 *
 * <h3>何を書くか</h3>
 * <ul>
 *   <li>動画: H.264 High の MP4 を 1 フラグメントに包んだ DICOM。{@code modality="US"} なら
 *       <b>US Multi-frame</b>、それ以外は Video Photographic（本体の非 DICOM 取り込みと同じ）</li>
 *   <li>フレームごとの値（任意）: {@link FrameValuesSr}。UID は動画とプラグインから決め打ち
 *       （同じ動画を採点し直したら置き換わる）</li>
 * </ul>
 * standalone 専用（元ファイルは利用者の端末にある）。
 */
@Service
public class PluginVideoImportService {

    private static final Logger log = LoggerFactory.getLogger(PluginVideoImportService.class);
    private static final DateTimeFormatter DA = DateTimeFormatter.ofPattern("yyyyMMdd");
    private static final DateTimeFormatter TM = DateTimeFormatter.ofPattern("HHmmss");
    private static final Pattern PROGRESS_FRAME = Pattern.compile("^frame=(\\d+)");

    private final DicomStorageService storage;
    private final FfmpegLocator ffmpeg;

    public PluginVideoImportService(DicomStorageService storage, FfmpegLocator ffmpeg) {
        this.storage = storage;
        this.ffmpeg = ffmpeg;
    }

    /** 既に取り込まれている動画（重複の知らせ）。 */
    public record Existing(String sopInstanceUid, String studyInstanceUid, String patientId, String patientName) {
    }

    /** H47 の結果（画面へはこの平らな形で返す）。 */
    public record ProbeResult(
            String path,
            String fileName,
            long sizeBytes,
            String sha256,
            String codec,
            int width,
            int height,
            double fps,
            int frameCount,
            double durationSec,
            Existing alreadyImported) {

        static ProbeResult of(VideoProbe.Info i, Existing e) {
            return new ProbeResult(i.path(), i.fileName(), i.sizeBytes(), i.sha256(), i.codec(), i.width(),
                    i.height(), i.fps(), i.frameCount(), i.durationSec(), e);
        }
    }

    /** 新しい患者。 */
    public record NewPatient(String patientId, String patientName, String birthDate, String sex) {
    }

    /** 患者の指定（どちらか一方）。 */
    public record PatientSpec(String patientKey, NewPatient create) {
    }

    /** H48 の要求（プラグインが渡すもの）。 */
    public record ImportRequest(
            String path,
            PatientSpec patient,
            String modality,
            String studyInstanceUid,
            String studyDescription,
            String seriesDescription,
            FrameValuesSr.Content frameValues) {
    }

    /** H48 の結果。 */
    public record ImportResult(
            boolean duplicate,
            String sopInstanceUid,
            String seriesInstanceUid,
            String studyInstanceUid,
            String patientId,
            int numberOfFrames,
            boolean transcoded,
            String frameValuesSopInstanceUid,
            String frameValuesError) {
    }

    // ── H47 ──

    public ProbeResult probe(String path) throws IOException {
        VideoProbe.Info info = VideoProbe.probe(ffmpeg.resolve(), Path.of(path), null);
        return ProbeResult.of(info, existing(info.sha256()));
    }

    /** 同じ動画（同じ SHA-256）が保管庫にあればその所在。 */
    private Existing existing(String sha) {
        String sop = videoSopUid(sha);
        List<DicomInstance> hit = storage.findMatches(null, null, null, sop);
        if (hit.isEmpty()) return null;
        DicomInstance d = hit.get(0);
        return new Existing(sop, d.getStudyInstanceUid(), d.getPatientId(), d.getPatientName());
    }

    static String videoSopUid(String sha) {
        return VideoProbe.uidFrom("graphy-next/plugin-video/sop", sha);
    }

    static String videoSeriesUid(String sha) {
        return VideoProbe.uidFrom("graphy-next/plugin-video/series", sha);
    }

    static String frameValuesSopUid(String pluginId, String videoSop) {
        return VideoProbe.uidFrom("graphy-next/plugin-frame-values/sop", pluginId + "\n" + videoSop);
    }

    static String frameValuesSeriesUid(String pluginId, String videoSop) {
        return VideoProbe.uidFrom("graphy-next/plugin-frame-values/series", pluginId + "\n" + videoSop);
    }

    // ── H48 ──

    /**
     * 取り込む（ジョブの中で呼ぶ）。進み具合: 指紋 0〜10% → 変換 10〜90% → 書き込み 90〜100%。
     *
     * @throws IllegalArgumentException 要求が不正（患者が無い・スタディが別の患者のもの 等）
     * @throws CancellationException    取り消された
     */
    public ImportResult importVideo(ImportRequest req, FrameValuesSr.Producer producer,
                                    PluginJobService.TaskContext ctx) throws IOException {
        if (req == null || req.path() == null || req.path().isBlank()) throw new IllegalArgumentException("path は必須です");
        Path src = Path.of(req.path());
        if (!Files.isRegularFile(src)) throw new IllegalArgumentException("ファイルがありません: " + req.path());
        Attributes patient = resolvePatient(req.patient(), req.studyInstanceUid());
        String patientId = patient.getString(Tag.PatientID, "");

        ctx.progress().accept(0.0, "hash");
        String sha = VideoProbe.sha256(src, p -> ctx.progress().accept(0.1 * p, "hash"));
        checkCancelled(ctx);
        Existing dup = existing(sha);
        if (dup != null) {
            log.info("[plugin-video] duplicate {} (already {})", src.getFileName(), dup.sopInstanceUid());
            return new ImportResult(true, dup.sopInstanceUid(), null, dup.studyInstanceUid(), dup.patientId(),
                    0, false, null, null);
        }

        String studyUid;
        Attributes study = new Attributes();
        LocalDateTime now = LocalDateTime.now();
        if (req.studyInstanceUid() != null && !req.studyInstanceUid().isBlank()) {
            // 同じ取り込みの 2 本目以降。🔴 別の患者のスタディには足させない（他人の検査に動画が生える）
            List<DicomInstance> in = storage.findMatches(null, req.studyInstanceUid(), null, null);
            if (in.isEmpty()) throw new IllegalArgumentException("スタディがありません: " + req.studyInstanceUid());
            if (!patientId.equals(in.get(0).getPatientId())) {
                throw new IllegalArgumentException("そのスタディは別の患者のものです");
            }
            studyUid = req.studyInstanceUid();
            Attributes h = readHeader(storage.resolveInstanceFile(in.get(0).getSopInstanceUid()));
            for (int tag : new int[] {Tag.StudyDate, Tag.StudyTime, Tag.StudyID, Tag.AccessionNumber,
                    Tag.StudyDescription, Tag.ReferringPhysicianName}) {
                copy(h, study, tag);
            }
        } else {
            studyUid = UIDUtils.createUID();
            study.setString(Tag.StudyDate, VR.DA, now.format(DA));
            study.setString(Tag.StudyTime, VR.TM, now.format(TM));
            study.setString(Tag.StudyID, VR.SH, "1");
            study.setString(Tag.AccessionNumber, VR.SH, "");
            study.setString(Tag.StudyDescription, VR.LO, clip(nz(req.studyDescription()), 64));
            study.setString(Tag.ReferringPhysicianName, VR.PN, "");
        }

        Path mp4 = src;
        Path transcoded = null;
        Path part10 = null;
        try {
            VideoConverter.Mp4Info mp4Info = isMp4(src) ? VideoConverter.inspectMp4(src) : null;
            if (mp4Info != null && evenSize(mp4Info.attrs())) {
                ctx.progress().accept(0.9, "wrap");
            } else {
                transcoded = Files.createTempFile("plugin-video-", ".mp4");
                transcode(src, transcoded, ctx);
                mp4 = transcoded;
                mp4Info = VideoConverter.inspectMp4(transcoded);
                if (mp4Info == null) throw new IOException("変換後の MP4 を解析できませんでした");
            }
            checkCancelled(ctx);

            boolean us = "US".equalsIgnoreCase(req.modality());
            Attributes a = new Attributes();
            a.addAll(patient);
            a.addAll(study);
            a.setString(Tag.StudyInstanceUID, VR.UI, studyUid);
            String sop = videoSopUid(sha);
            String seriesUid = videoSeriesUid(sha);
            a.setString(Tag.SOPClassUID, VR.UI, us ? UID.UltrasoundMultiFrameImageStorage : UID.VideoPhotographicImageStorage);
            a.setString(Tag.SOPInstanceUID, VR.UI, sop);
            a.setString(Tag.SeriesInstanceUID, VR.UI, seriesUid);
            a.setString(Tag.Modality, VR.CS, us ? "US" : "XC");
            a.setInt(Tag.SeriesNumber, VR.IS, nextSeriesNumber(studyUid));
            a.setInt(Tag.InstanceNumber, VR.IS, 1);
            String desc = req.seriesDescription() != null && !req.seriesDescription().isBlank()
                    ? req.seriesDescription().trim() : stripExt(src.getFileName().toString());
            a.setString(Tag.SeriesDescription, VR.LO, clip(FrameValuesSr.PLUGIN_PREFIX + desc, 64));
            a.setString(Tag.ContentDate, VR.DA, now.format(DA));
            a.setString(Tag.ContentTime, VR.TM, now.format(TM));
            a.setString(Tag.ImageType, VR.CS, "ORIGINAL", "PRIMARY");
            a.setString(Tag.ConversionType, VR.CS, "WSD");
            a.setString(Tag.Manufacturer, VR.LO, "GRAPHY-Next");
            a.setString(Tag.DerivationDescription, VR.ST,
                    "Imported from non-DICOM video " + src.getFileName() + " (SHA-256 " + sha + ")"
                            + (transcoded != null ? ", transcoded to H.264 High" : ""));
            a.newSequence(Tag.ContributingEquipmentSequence, 1).add(FrameValuesSr.equipment(producer));
            a.addAll(mp4Info.attrs()); // Rows/Columns/NumberOfFrames/FrameTime/Photometric...
            int frames = a.getInt(Tag.NumberOfFrames, 0);

            // フレームごとの値は動画を書く前に確かめる（長さ違いで SR だけ失敗し、動画だけ残るのを避ける）
            String fvError = null;
            if (req.frameValues() != null) {
                try {
                    FrameValuesSr.validate(req.frameValues(), frames);
                } catch (IllegalArgumentException e) {
                    fvError = e.getMessage();
                }
            }

            ctx.progress().accept(0.92, "write");
            part10 = Files.createTempFile("plugin-video-", ".dcm");
            VideoConverter.writeEncapsulated(a, mp4Info.transferSyntaxUid(), mp4, part10);
            storage.importFromFile(part10);

            String fvSop = null;
            if (req.frameValues() != null && fvError == null) {
                fvSop = writeFrameValues(a, req.frameValues(), producer, now);
            }
            ctx.progress().accept(1.0, "done");
            log.info("[plugin-video] imported {} as {} ({} frames, transcoded={}, frameValues={})",
                    src.getFileName(), sop, frames, transcoded != null, fvSop != null);
            return new ImportResult(false, sop, seriesUid, studyUid, patientId, frames, transcoded != null, fvSop, fvError);
        } finally {
            if (transcoded != null) Files.deleteIfExists(transcoded);
            if (part10 != null) Files.deleteIfExists(part10);
        }
    }

    private String writeFrameValues(Attributes video, FrameValuesSr.Content c, FrameValuesSr.Producer producer,
                                    LocalDateTime now) throws IOException {
        String videoSop = video.getString(Tag.SOPInstanceUID);
        Attributes sr = FrameValuesSr.build(video, c, producer,
                frameValuesSopUid(producer.id(), videoSop), frameValuesSeriesUid(producer.id(), videoSop), now);
        Path tmp = Files.createTempFile("plugin-frame-values-", ".dcm");
        try {
            try (DicomOutputStream dos = new DicomOutputStream(tmp.toFile())) {
                dos.writeDataset(sr.createFileMetaInformation(UID.ExplicitVRLittleEndian), sr);
            }
            storage.importFromFile(tmp);
        } finally {
            Files.deleteIfExists(tmp);
        }
        return sr.getString(Tag.SOPInstanceUID);
    }

    // ── H49 ──

    /** 動画に付いた、そのプラグインのフレームごとの値を読む。無ければ null。 */
    public FrameValuesSr.Read readFrameValues(String pluginId, String videoSop) throws IOException {
        Path f = storage.resolveInstanceFile(frameValuesSopUid(pluginId, videoSop));
        if (f == null) return null;
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            FrameValuesSr.Read r = FrameValuesSr.read(in.readDataset());
            return r != null && videoSop.equals(r.videoSopInstanceUid()) ? r : null;
        }
    }

    // ── 患者 ──

    /**
     * 患者の属性を決める。既存なら<b>その患者の既存インスタンスから写す</b>（名前の表記・文字集合を揃える）。
     * 新規は患者 ID が既にあれば拒否する（別人の記録に混ざるのを防ぐ。既存なら検索から選ばせる）。
     */
    Attributes resolvePatient(PatientSpec spec, String continuingStudyUid) throws IOException {
        if (spec == null || (spec.patientKey() == null && spec.create() == null)) {
            throw new IllegalArgumentException("患者の指定がありません");
        }
        Attributes p = new Attributes();
        if (spec.patientKey() != null && !spec.patientKey().isBlank()) {
            List<DicomInstance> hit = storage.findMatches(spec.patientKey(), null, null, null);
            if (hit.isEmpty()) throw new IllegalArgumentException("患者が見つかりません: " + spec.patientKey());
            Attributes h = readHeader(storage.resolveInstanceFile(hit.get(0).getSopInstanceUid()));
            for (int tag : new int[] {Tag.SpecificCharacterSet, Tag.PatientID, Tag.PatientName,
                    Tag.PatientBirthDate, Tag.PatientSex}) {
                copy(h, p, tag);
            }
        } else {
            NewPatient n = spec.create();
            String id = n.patientId() == null ? "" : n.patientId().trim();
            if (id.isEmpty()) throw new IllegalArgumentException("患者 ID は必須です");
            if (id.length() > 64) throw new IllegalArgumentException("患者 ID が長すぎます（64 文字まで）");
            if (!storage.findMatches(id, null, null, null).isEmpty()) {
                // 同じ取り込みの 2 本目以降: 1 本目がこの患者を作った。そのスタディ（同じ患者のもの）を
                // 渡してきたときだけ、その患者として続ける（属性は 1 本目が書いたものを写す）
                List<DicomInstance> cont = continuingStudyUid == null || continuingStudyUid.isBlank()
                        ? List.of() : storage.findMatches(id, continuingStudyUid, null, null);
                if (cont.isEmpty()) {
                    throw new IllegalArgumentException("患者 ID " + id + " は既にあります。既存の患者から選んでください");
                }
                return resolvePatient(new PatientSpec(id, null), null);
            }
            String birth = n.birthDate() == null ? "" : n.birthDate().trim();
            if (!birth.isEmpty() && !birth.matches("\\d{8}")) throw new IllegalArgumentException("生年月日は YYYYMMDD");
            String sex = n.sex() == null ? "" : n.sex().trim().toUpperCase(Locale.ROOT);
            if (!sex.isEmpty() && !sex.matches("[MFO]")) throw new IllegalArgumentException("性別は M / F / O");
            p.setSpecificCharacterSet("ISO_IR 192");
            p.setString(Tag.PatientID, VR.LO, id);
            p.setString(Tag.PatientName, VR.PN, nz(n.patientName()).trim());
            p.setString(Tag.PatientBirthDate, VR.DA, birth);
            p.setString(Tag.PatientSex, VR.CS, sex);
        }
        if (p.getString(Tag.SpecificCharacterSet) == null) p.setSpecificCharacterSet("ISO_IR 192");
        return p;
    }

    // ── 変換 ──

    /** ffmpeg で H.264 High（偶数寸法・B フレーム無し・faststart）へ。進み具合は 10〜90%。 */
    private void transcode(Path src, Path out, PluginJobService.TaskContext ctx) throws IOException {
        int total = 0;
        try {
            total = VideoProbe.probe(ffmpeg.resolve(), src, null).frameCount();
        } catch (IOException e) {
            log.debug("[plugin-video] frame count unknown: {}", e.toString());
        }
        List<String> cmd = new ArrayList<>(VideoConverter.transcodeCommand(ffmpeg.resolve(), src, out));
        // 進み具合を標準出力へ（最後の出力先の前に差し込む）
        cmd.addAll(cmd.size() - 1, List.of("-progress", "pipe:1", "-nostats", "-nostdin"));
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        StringBuilder tail = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                if (ctx.cancelled().getAsBoolean()) {
                    p.destroyForcibly();
                    throw new CancellationException();
                }
                Matcher m = PROGRESS_FRAME.matcher(line);
                if (m.find() && total > 0) {
                    ctx.progress().accept(0.1 + 0.8 * Math.min(1, Integer.parseInt(m.group(1)) / (double) total), "transcode");
                }
                if (tail.length() > 4000) tail.delete(0, 2000);
                tail.append(line).append('\n');
            }
        }
        try {
            if (!p.waitFor(30, TimeUnit.MINUTES)) {
                p.destroyForcibly();
                throw new IOException("ffmpeg timed out");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            p.destroyForcibly();
            throw new IOException("ffmpeg interrupted", e);
        }
        if (p.exitValue() != 0) {
            log.warn("[plugin-video] ffmpeg failed ({}):\n{}", p.exitValue(), tail);
            throw new IOException("ffmpeg の変換に失敗しました（exit " + p.exitValue() + "）");
        }
    }

    // ── 小道具 ──

    private int nextSeriesNumber(String studyUid) {
        int max = 0;
        for (DicomInstance d : storage.findMatches(null, studyUid, null, null)) {
            if (d.getSeriesNumber() != null && d.getSeriesNumber() < 9000) max = Math.max(max, d.getSeriesNumber());
        }
        return max + 1;
    }

    private static void checkCancelled(PluginJobService.TaskContext ctx) {
        if (ctx.cancelled().getAsBoolean()) throw new CancellationException();
    }

    private static boolean isMp4(Path p) {
        String n = p.getFileName().toString().toLowerCase(Locale.ROOT);
        return n.endsWith(".mp4") || n.endsWith(".m4v");
    }

    private static boolean evenSize(Attributes a) {
        int rows = a.getInt(Tag.Rows, 1);
        int cols = a.getInt(Tag.Columns, 1);
        return rows % 2 == 0 && cols % 2 == 0;
    }

    private static Attributes readHeader(Path p) throws IOException {
        if (p == null) throw new IOException("インスタンスのファイルがありません");
        try (DicomInputStream in = new DicomInputStream(p.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.NO);
            return in.readDatasetUntilPixelData();
        }
    }

    private static void copy(Attributes from, Attributes to, int tag) {
        if (!from.contains(tag)) return;
        String[] v = from.getStrings(tag);
        if (v != null && v.length > 0) to.setString(tag, from.getVR(tag), v);
    }

    private static String stripExt(String n) {
        int dot = n.lastIndexOf('.');
        return dot < 0 ? n : n.substring(0, dot);
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private static String clip(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }

}

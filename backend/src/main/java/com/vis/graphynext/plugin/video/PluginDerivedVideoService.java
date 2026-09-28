/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin.video;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.nondicom.VideoConverter;
import com.vis.graphynext.plugin.PluginArtifacts;
import com.vis.graphynext.plugin.PluginJobService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.util.UIDUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CancellationException;

/**
 * プラグインが作った動画（ジョブの成果物の MP4）を、元の動画から派生したシリーズとして<b>本体が</b>
 * DICOM に書く（host API の H54。例: UVS の要約動画）。
 *
 * <h3>🔴 DICOM はプラグインに書かせない（H4b / H9 / H48 と同じ）</h3>
 * プラグインが渡すのは「MP4（H53 の成果物）・元の SOP・採ったフレームの番号・説明」だけ。
 * UID・患者/検査の継承・派生の印・参照・出所（{@code [Plugin] }・ContributingEquipment）は本体が入れる。
 * 規則は UVS 単体アプリの {@code SummaryDicomExporter.buildDerivedDataset} と同じ:
 * <ul>
 *   <li>元の属性を写す（画素を除く）。新しい Series / SOP Instance UID・同じ検査・SeriesNumber = 最大 + 1</li>
 *   <li>{@code ImageType = DERIVED\SECONDARY}・DerivationDescription・ContributingEquipment</li>
 *   <li>{@code ReferencedSeriesSequence}（元のシリーズ）→ {@code ReferencedInstanceSequence}（元の SOP と ReferencedFrameNumber）</li>
 *   <li>SOP クラスは元が US Multi-frame・動画系ならそのまま、ほかは US Multi-frame。転送構文は MP4 のもの（H.264）</li>
 * </ul>
 * 行き先は {@code target}: {@code "db"}（保管庫へ登録）か {@code "file"}（.dcm を成果物にして H53 で保存させる）。
 */
@Service
public class PluginDerivedVideoService {

    private static final Logger log = LoggerFactory.getLogger(PluginDerivedVideoService.class);
    private static final DateTimeFormatter DA = DateTimeFormatter.ofPattern("yyyyMMdd");
    private static final DateTimeFormatter TM = DateTimeFormatter.ofPattern("HHmmss");

    /** そのまま保つ SOP クラス（動画として意味が通るもの）。 */
    private static final Set<String> KEEP_SOP_CLASSES = Set.of(
            UID.UltrasoundMultiFrameImageStorage,
            UID.VideoEndoscopicImageStorage,
            UID.VideoMicroscopicImageStorage,
            UID.VideoPhotographicImageStorage);

    /** 画素と一緒に意味が変わる・派生で持ち越してはいけない属性。 */
    private static final int[] DROP = {
            Tag.PixelData, Tag.NumberOfFrames, Tag.FrameTime, Tag.FrameTimeVector, Tag.FrameIncrementPointer,
            Tag.StartTrim, Tag.StopTrim, Tag.RecommendedDisplayFrameRate, Tag.CineRate, Tag.ActualFrameDuration,
            Tag.SourceImageSequence, Tag.ReferencedSeriesSequence, Tag.DerivationCodeSequence,
            Tag.ContributingEquipmentSequence, Tag.LossyImageCompression, Tag.LossyImageCompressionRatio,
            Tag.LossyImageCompressionMethod, Tag.PhotometricInterpretation, Tag.PlanarConfiguration,
            Tag.BitsAllocated, Tag.BitsStored, Tag.HighBit, Tag.PixelRepresentation, Tag.SamplesPerPixel,
            Tag.Rows, Tag.Columns};

    private final DicomStorageService storage;
    private final PluginArtifacts artifacts;

    public PluginDerivedVideoService(DicomStorageService storage, PluginArtifacts artifacts) {
        this.storage = storage;
        this.artifacts = artifacts;
    }

    /** H54 の要求（プラグインが渡すもの）。 */
    public record DerivedRequest(
            String artifactJobId,
            String sourceSopInstanceUid,
            List<Integer> referencedFrames,
            String seriesDescription,
            String derivationDescription,
            String target) {
    }

    /** H54 の結果。{@code target=file} のときは SOP 等に加え、結果の {@code __artifact} に .dcm が載る。 */
    public record DerivedResult(String target, String sopInstanceUid, String seriesInstanceUid, String studyInstanceUid,
                                int numberOfFrames, String seriesDescription) {
    }

    /**
     * 派生シリーズを組んで書く。
     *
     * @param mp4 成果物の MP4（H53 が預かっているもの。呼び出し側がプラグインの一致を確かめる）
     */
    public Object write(DerivedRequest req, Path mp4, FrameValuesSr.Producer producer, PluginJobService.TaskContext ctx)
            throws IOException {
        boolean toFile = "file".equalsIgnoreCase(req.target());
        if (!toFile && !"db".equalsIgnoreCase(req.target())) throw new IllegalArgumentException("target は db か file");
        String srcSop = req.sourceSopInstanceUid();
        if (srcSop == null || srcSop.isBlank()) throw new IllegalArgumentException("元の SOP Instance UID が要ります");
        Path srcFile = storage.resolveInstanceFile(srcSop);
        if (srcFile == null) throw new IllegalArgumentException("元のインスタンスが見つかりません: " + srcSop);
        ctx.progress().accept(0.05, "inspect");
        VideoConverter.Mp4Info info = VideoConverter.inspectMp4(mp4);
        if (info == null) throw new IOException("MP4 を解析できませんでした（H.264 で偶数寸法の MP4 を渡してください）");
        Attributes src = readHeader(srcFile);
        checkCancelled(ctx);

        Attributes a = build(src, info, req, producer, nextSeriesNumber(src.getString(Tag.StudyInstanceUID)),
                LocalDateTime.now());
        int frames = a.getInt(Tag.NumberOfFrames, 0);
        ctx.progress().accept(0.5, "write");
        Path part10 = Files.createTempFile("plugin-derived-", ".dcm");
        try {
            VideoConverter.writeEncapsulated(a, info.transferSyntaxUid(), mp4, part10);
            checkCancelled(ctx);
            DerivedResult r = new DerivedResult(toFile ? "file" : "db", a.getString(Tag.SOPInstanceUID),
                    a.getString(Tag.SeriesInstanceUID), a.getString(Tag.StudyInstanceUID), frames,
                    a.getString(Tag.SeriesDescription));
            if (toFile) {
                // H53 に預ける（ジョブの結果の __artifact を PluginJobService が拾う）
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("result", r);
                out.put(PluginArtifacts.ARTIFACT_KEY, part10.toString());
                out.put(PluginArtifacts.ARTIFACT_NAME_KEY, "summary.dcm");
                part10 = null; // 移すのは PluginJobService（消さない）
                log.info("[plugin-video] derived DICOM file for {} ({} frames)", srcSop, frames);
                return out;
            }
            storage.importFromFile(part10);
            log.info("[plugin-video] derived series {} stored from {} ({} frames)", r.seriesInstanceUid(), srcSop, frames);
            ctx.progress().accept(1.0, "done");
            return Map.of("result", r);
        } finally {
            if (part10 != null) Files.deleteIfExists(part10);
        }
    }

    /** データセットを組む（画素は含まない）。テストのために分けた。 */
    static Attributes build(Attributes src, VideoConverter.Mp4Info info, DerivedRequest req,
                            FrameValuesSr.Producer producer, int seriesNumber, LocalDateTime now) {
        Attributes a = new Attributes(src);
        for (int t : DROP) a.remove(t);
        String srcClass = src.getString(Tag.SOPClassUID, UID.UltrasoundMultiFrameImageStorage);
        String sopClass = KEEP_SOP_CLASSES.contains(srcClass) ? srcClass : UID.UltrasoundMultiFrameImageStorage;
        a.setString(Tag.SOPClassUID, VR.UI, sopClass);
        a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        a.setString(Tag.SeriesInstanceUID, VR.UI, UIDUtils.createUID());
        a.setInt(Tag.SeriesNumber, VR.IS, seriesNumber);
        a.setInt(Tag.InstanceNumber, VR.IS, 1);
        String desc = req.seriesDescription() == null || req.seriesDescription().isBlank()
                ? "Derived video" : req.seriesDescription().trim();
        a.setString(Tag.SeriesDescription, VR.LO, clip(FrameValuesSr.PLUGIN_PREFIX + desc, 64));
        a.setString(Tag.ImageType, VR.CS, "DERIVED", "SECONDARY");
        a.setString(Tag.SeriesDate, VR.DA, now.format(DA));
        a.setString(Tag.SeriesTime, VR.TM, now.format(TM));
        a.setString(Tag.ContentDate, VR.DA, now.format(DA));
        a.setString(Tag.ContentTime, VR.TM, now.format(TM));
        String deriv = req.derivationDescription() == null || req.derivationDescription().isBlank()
                ? "Derived by plugin " + producer.name() : req.derivationDescription().trim();
        a.setString(Tag.DerivationDescription, VR.ST, clip(deriv, 1024));
        a.newSequence(Tag.ContributingEquipmentSequence, 1).add(FrameValuesSr.equipment(producer));

        // 元への参照（どのフレームを採ったか）
        Attributes inst = new Attributes();
        inst.setString(Tag.ReferencedSOPClassUID, VR.UI, srcClass);
        inst.setString(Tag.ReferencedSOPInstanceUID, VR.UI, src.getString(Tag.SOPInstanceUID));
        List<Integer> frames = req.referencedFrames() == null ? List.of() : req.referencedFrames();
        if (!frames.isEmpty()) inst.setInt(Tag.ReferencedFrameNumber, VR.IS, frames.stream().mapToInt(Integer::intValue).toArray());
        Attributes series = new Attributes();
        series.setString(Tag.SeriesInstanceUID, VR.UI, src.getString(Tag.SeriesInstanceUID));
        Sequence insts = series.newSequence(Tag.ReferencedInstanceSequence, 1);
        insts.add(inst);
        a.newSequence(Tag.ReferencedSeriesSequence, 1).add(series);

        a.addAll(info.attrs()); // Rows/Columns/NumberOfFrames/FrameTime/Photometric/...（MP4 から）
        a.setString(Tag.LossyImageCompression, VR.CS, "01");
        a.setString(Tag.LossyImageCompressionMethod, VR.CS, "ISO_14496_10");
        return a;
    }

    private int nextSeriesNumber(String studyUid) {
        int max = 0;
        for (DicomInstance d : storage.findMatches(null, studyUid, null, null)) {
            if (d.getSeriesNumber() != null && d.getSeriesNumber() < 9000) max = Math.max(max, d.getSeriesNumber());
        }
        return max + 1;
    }

    private static Attributes readHeader(Path p) throws IOException {
        try (DicomInputStream in = new DicomInputStream(p.toFile())) {
            in.setIncludeBulkData(DicomInputStream.IncludeBulkData.NO);
            return in.readDatasetUntilPixelData();
        }
    }

    private static void checkCancelled(PluginJobService.TaskContext ctx) {
        if (ctx.cancelled().getAsBoolean()) throw new CancellationException();
    }

    private static String clip(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }
}

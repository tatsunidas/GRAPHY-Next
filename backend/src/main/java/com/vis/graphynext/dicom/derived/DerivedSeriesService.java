/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.derived;

import com.vis.graphynext.dicom.store.DicomStorageService;
import com.vis.graphynext.dicom.web.WebDicomDataService;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.dcm4che3.io.DicomOutputStream;
import org.dcm4che3.util.UIDUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * 派生（セカンダリ）シリーズ生成サービス。Slicer のリスライス結果を、元シリーズ属性を引き継ぎつつ
 * 新シリーズとして保管庫へ取り込む（設計 {@code fw/slicer-design.md} §7）。
 *
 * <p>元 Study/FrameOfReferenceUID/患者・検査属性・Modality/SOPClassUID/Rescale/VOI は維持。
 * SeriesInstanceUID/SOPInstanceUID を新規採番、ImageType=DERIVED\SECONDARY\RESLICE、
 * IOP/IPP/PixelSpacing/SliceThickness/SpacingBetweenSlices を再構成値で更新する。
 * 画素は 16bit signed（MONOCHROME2, RescaleSlope=1/Intercept=0：フロントの volume 値がそのまま
 * 表示値＝CT は HU）。保存は {@link DicomStorageService#ingest(Path)}（トランザクション＋孤児回避）。
 */
@Service
public class DerivedSeriesService {

    private static final Logger log = LoggerFactory.getLogger(DerivedSeriesService.class);

    /** プラグイン出力の SeriesDescription 接頭辞（一覧で人が気付けるようにする）。 */
    static final String PLUGIN_PREFIX = "[Plugin] ";

    private final DicomStorageService storage;
    /** web モードのときだけ存在（STOW-RS 書き戻し用）。standalone では null。 */
    private final ObjectProvider<WebDicomDataService> webProvider;

    public DerivedSeriesService(DicomStorageService storage, ObjectProvider<WebDicomDataService> webProvider) {
        this.storage = storage;
        this.webProvider = webProvider;
    }

    /** 生成結果。 */
    public record Result(String seriesInstanceUid, List<String> sopInstanceUids) {}

    /** 元シリーズ属性を引き継いで派生シリーズを生成・保存する。 */
    public Result create(DerivedSeriesRequest req) throws IOException {
        validate(req);

        WebDicomDataService web = webProvider != null ? webProvider.getIfAvailable() : null;

        // 属性テンプレート = 元シリーズの代表インスタンスのヘッダ。
        // standalone はローカルファイルから、web は WADO-RS /metadata の先頭インスタンスから引き継ぐ。
        Attributes tmpl;
        if (web != null) {
            List<Attributes> metas = web.seriesMetadata(req.studyInstanceUid(), req.seriesInstanceUid());
            if (metas.isEmpty()) {
                throw new IllegalArgumentException("元シリーズが見つかりません (web, study="
                        + req.studyInstanceUid() + ", series=" + req.seriesInstanceUid() + ")");
            }
            tmpl = metas.get(0);
        } else {
            List<Path> srcFiles = storage.resolveFiles(req.studyInstanceUid(), List.of(req.seriesInstanceUid()));
            if (srcFiles.isEmpty()) {
                throw new IllegalArgumentException("元シリーズが見つかりません (study=" + req.studyInstanceUid()
                        + ", series=" + req.seriesInstanceUid() + ")");
            }
            tmpl = readHeader(srcFiles.get(0));
        }

        String newSeriesUid = UIDUtils.createUID();
        int seriesNumber = req.seriesNumber() != null ? req.seriesNumber()
                : tmpl.getInt(Tag.SeriesNumber, 0) + 1000;
        String modality = tmpl.getString(Tag.Modality, "OT");

        int expectedBytes = req.rows() * req.columns() * 2;
        List<String> sops = new ArrayList<>(req.frames().size());
        // web は STOW-RS 送信用に Attributes をまとめて 1 リクエストで書き戻す。standalone は逐次 ingest。
        List<Attributes> stowBatch = web != null ? new ArrayList<>(req.frames().size()) : null;
        for (DerivedSeriesRequest.Frame f : req.frames()) {
            byte[] px = Base64.getDecoder().decode(f.pixels());
            if (px.length != expectedBytes) {
                throw new IllegalArgumentException("画素バイト長が rows*columns*2 と一致しません (instance="
                        + f.instanceNumber() + ", got=" + px.length + ", expected=" + expectedBytes + ")");
            }
            Attributes a = buildInstance(tmpl, req, newSeriesUid, seriesNumber, modality, f, px);
            if (sops.isEmpty()) {
                // 先頭インスタンスで 1 度だけ検査する（全フレームで同じ属性なので）。
                // ★ 定量に必要なタグが欠けたまま保存しない（設計 §8.3）。
                // Modality=PT のまま SUV だけ出せないシリーズは、開けてしまうぶん
                // 「壊れている」と気付くのが最も遅い。作る前に落とす。
                List<String> missing = ModalityAttributeInheritance.missingRequired(a, modality);
                if (!missing.isEmpty()) {
                    throw new IllegalArgumentException(
                            "派生シリーズを作成できません: " + modality + " の定量に必要な属性が"
                            + "元シリーズから引き継げませんでした（" + String.join(", ", missing) + "）。"
                            + "このまま保存すると、見た目は " + modality + " なのに SUV が計算できない"
                            + "シリーズになります。");
                }
            }
            sops.add(a.getString(Tag.SOPInstanceUID));
            if (web != null) {
                stowBatch.add(a);
            } else {
                ingest(a);
            }
        }
        if (web != null) {
            web.storeDatasets(stowBatch); // STOW-RS で PACS へ保存
        }
        log.info("derived series created: {} ({} instances) from {} [{}]", newSeriesUid, sops.size(),
                req.seriesInstanceUid(), web != null ? "STOW-RS" : "local");
        return new Result(newSeriesUid, sops);
    }

    private void validate(DerivedSeriesRequest req) {
        if (req.studyInstanceUid() == null || req.studyInstanceUid().isBlank()
                || req.seriesInstanceUid() == null || req.seriesInstanceUid().isBlank()) {
            throw new IllegalArgumentException("studyInstanceUid / seriesInstanceUid は必須です");
        }
        if (req.frames() == null || req.frames().isEmpty()) {
            throw new IllegalArgumentException("frames が空です");
        }
        if (req.rows() <= 0 || req.columns() <= 0) {
            throw new IllegalArgumentException("rows / columns が不正です");
        }
        // IOP は「6 要素」または「省略（null/空）」のみ許可。省略時は幾何なし（Curved MPR 等）。
        double[] iop = req.imageOrientationPatient();
        if (iop != null && iop.length != 0 && iop.length != 6) {
            throw new IllegalArgumentException("imageOrientationPatient は 6 要素または省略が必要です");
        }
        if (req.pixelSpacing() == null || req.pixelSpacing().length != 2) {
            throw new IllegalArgumentException("pixelSpacing は 2 要素が必要です");
        }
    }

    /** タグ 1 個を VR・多値を保ってコピーする（存在時のみ）。 */
    private static void copyTag(Attributes from, Attributes to, int tag) {
        if (!from.contains(tag)) {
            return;
        }
        VR vr = from.getVR(tag);
        String[] v = from.getStrings(tag);
        if (v != null && v.length > 0) {
            to.setString(tag, vr, v);
        }
    }

    /** 元シリーズ代表インスタンスのデータセット（ピクセル無し）を読む。 */
    private Attributes readHeader(Path p) throws IOException {
        try (DicomInputStream in = new DicomInputStream(p.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            return in.readDataset();
        }
    }

    /** 1 スライスの Attributes を構築する（属性引き継ぎ＋幾何/画素更新）。 */
    private Attributes buildInstance(Attributes tmpl, DerivedSeriesRequest req, String newSeriesUid,
                                     int seriesNumber, String modality, DerivedSeriesRequest.Frame f, byte[] px) {
        Attributes a = new Attributes();
        // 幾何（IOP/IPP）を持つか。Curved MPR 等の曲面/平坦化再構成では省略される。
        double[] iop = req.imageOrientationPatient();
        boolean hasGeom = iop != null && iop.length == 6;

        // 患者/検査属性に加え、**モダリティ固有の属性**を元シリーズから引き継ぐ
        // （設計 fw/registration-design.md §8.3）。PET の Units / 放射性医薬品シーケンス /
        // 体重 / 減衰補正の基準時刻が欠けると、Modality=PT のまま SUV だけが計算できない
        // シリーズができてしまう。
        ModalityAttributeInheritance.inherit(tmpl, a, modality);
        // FrameOfReferenceUID は幾何がある場合のみ付ける（IPP/IOP 無しで付けると空間登録を偽装するため）。
        // ★ 出どころは「属性テンプレート（元シリーズ）」とは限らない。位置合わせの結果は
        //   fixed の座標系にあるので、その場合は呼び出し側が fixed の FoR を渡す。
        if (hasGeom) {
            if (req.frameOfReferenceUid() != null && !req.frameOfReferenceUid().isBlank()) {
                a.setString(Tag.FrameOfReferenceUID, VR.UI, req.frameOfReferenceUid());
            } else {
                copyTag(tmpl, a, Tag.FrameOfReferenceUID);
            }
            copyTag(tmpl, a, Tag.PositionReferenceIndicator);
        }
        if (a.getString(Tag.SpecificCharacterSet) == null) {
            a.setSpecificCharacterSet("ISO_IR 192");
        }
        if (a.getString(Tag.StudyInstanceUID) == null) {
            // テンプレートに Study UID が無い異常系（想定外）はリクエストの値で補完。
            a.setString(Tag.StudyInstanceUID, VR.UI, req.studyInstanceUid());
        }

        // モダリティ / SOP Class は元を維持（CT なら CT Image Storage 等）。
        a.setString(Tag.Modality, VR.CS, modality);
        String srcSopClass = tmpl.getString(Tag.SOPClassUID);
        a.setString(Tag.SOPClassUID, VR.UI, srcSopClass != null ? srcSopClass : UID.SecondaryCaptureImageStorage);

        // シリーズ（新規）。
        a.setString(Tag.SeriesInstanceUID, VR.UI, newSeriesUid);
        a.setInt(Tag.SeriesNumber, VR.IS, seriesNumber);
        a.setString(Tag.SeriesDescription, VR.LO, seriesDescription(req));

        // インスタンス（新規）。
        a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        a.setInt(Tag.InstanceNumber, VR.IS, f.instanceNumber());
        // 幾何ありは平面リスライス（RESLICE）、幾何なしは曲面/平坦化再構成（DERIVED\SECONDARY のみ）。
        // プラグイン出力は幾何があってもリスライスではないので RESLICE を付けない
        // （マスクや解析マップに RESLICE と書くと他システムを誤らせる）。
        if (hasGeom && req.producer() == null) {
            a.setString(Tag.ImageType, VR.CS, "DERIVED", "SECONDARY", "RESLICE");
        } else {
            a.setString(Tag.ImageType, VR.CS, "DERIVED", "SECONDARY");
        }
        a.setString(Tag.DerivationDescription, VR.ST, derivationDescription(req));
        // プラグイン出力は機械可読な出所も残す（一覧の接頭辞と二重に明示する）。
        DerivedSeriesRequest.Producer producer = req.producer();
        if (producer != null) {
            Attributes eq = new Attributes(4);
            eq.setString(Tag.Manufacturer, VR.LO, "GRAPHY-Next plugin");
            eq.setString(Tag.ManufacturerModelName, VR.LO,
                    producer.name() != null && !producer.name().isBlank() ? producer.name() : producer.id());
            eq.setString(Tag.SoftwareVersions, VR.LO, producer.version() != null ? producer.version() : "");
            eq.setString(Tag.ContributionDescription, VR.ST, "Derived series produced by plugin " + producer.id());
            a.newSequence(Tag.ContributingEquipmentSequence, 1).add(eq);
        }
        copyTag(tmpl, a, Tag.ContentDate);
        copyTag(tmpl, a, Tag.ContentTime);

        // 画素モジュール（16bit signed MONOCHROME2）。
        a.setInt(Tag.Rows, VR.US, req.rows());
        a.setInt(Tag.Columns, VR.US, req.columns());
        a.setInt(Tag.BitsAllocated, VR.US, 16);
        a.setInt(Tag.BitsStored, VR.US, 16);
        a.setInt(Tag.HighBit, VR.US, 15);
        a.setInt(Tag.SamplesPerPixel, VR.US, 1);
        a.setInt(Tag.PixelRepresentation, VR.US, 1); // signed
        a.setString(Tag.PhotometricInterpretation, VR.CS, "MONOCHROME2");
        // Rescale: 既定は恒等（フロントの volume 値＝CT は HU がそのまま入る）。
        // プラグイン由来の値マップは Float32 を Int16 に量子化するため、呼び出し側が係数を渡す。
        double slope = req.rescaleSlope() != null ? req.rescaleSlope() : 1.0;
        double intercept = req.rescaleIntercept() != null ? req.rescaleIntercept() : 0.0;
        a.setDouble(Tag.RescaleIntercept, VR.DS, intercept);
        a.setDouble(Tag.RescaleSlope, VR.DS, slope);
        if (req.rescaleType() != null && !req.rescaleType().isBlank()) {
            a.setString(Tag.RescaleType, VR.LO, req.rescaleType());
        } else {
            // モダリティと Units から決める。PET は画素が Units の示す量（BQML 等）なので、
            // 「CT なら HU」だけでは PET に何も入らなかった。
            ModalityAttributeInheritance.setString(
                    a, Tag.RescaleType, VR.LO,
                    ModalityAttributeInheritance.defaultRescaleType(modality, tmpl));
        }
        // 「データ無し」を埋めた背景値をパディングとして明示する（VR は signed 画素なので SS）。
        // これがあると、ビューア側は W/L 自動計算や統計から背景を除外できる。
        if (req.pixelPaddingValue() != null) {
            a.setInt(Tag.PixelPaddingValue, VR.SS, req.pixelPaddingValue());
        }

        // 幾何（再構成値で更新）。PixelSpacing は常に付与、IOP/IPP は幾何がある場合のみ。
        if (hasGeom) {
            a.setDouble(Tag.ImageOrientationPatient, VR.DS, iop);
            double[] ipp = f.imagePositionPatient();
            if (ipp != null && ipp.length == 3) {
                a.setDouble(Tag.ImagePositionPatient, VR.DS, ipp);
            }
            a.setDouble(Tag.SpacingBetweenSlices, VR.DS, req.spacingBetweenSlices());
        }
        a.setDouble(Tag.PixelSpacing, VR.DS, req.pixelSpacing());
        a.setDouble(Tag.SliceThickness, VR.DS, req.sliceThickness());

        // トレーサビリティ: 元インスタンスへの参照。
        String srcSop = tmpl.getString(Tag.SOPInstanceUID);
        if (srcSopClass != null && srcSop != null) {
            Attributes ref = new Attributes(2);
            ref.setString(Tag.ReferencedSOPClassUID, VR.UI, srcSopClass);
            ref.setString(Tag.ReferencedSOPInstanceUID, VR.UI, srcSop);
            Sequence seq = a.newSequence(Tag.SourceImageSequence, 1);
            seq.add(ref);
        }

        // 画素データ（16bit → VR.OW, リトルエンディアン）。
        a.setBytes(Tag.PixelData, VR.OW, px);
        return a;
    }

    /**
     * シリーズ説明。プラグイン由来なら**一覧で見て分かる接頭辞**を必ず付ける
     * （`SeriesDescription` は他システムのシリーズ一覧にも出るため、ここが人向けの主要な手掛かり）。
     * 呼び出し側が既に接頭辞付きで渡してきた場合は二重に付けない。
     */
    static String seriesDescription(DerivedSeriesRequest req) {
        String desc = req.seriesDescription() != null && !req.seriesDescription().isBlank()
                ? req.seriesDescription().trim()
                : "Reslice";
        if (req.producer() == null || desc.startsWith(PLUGIN_PREFIX)) {
            return desc;
        }
        String out = PLUGIN_PREFIX + desc;
        // SeriesDescription は LO（64 文字）。接頭辞を優先して末尾を切る。
        return out.length() <= 64 ? out : out.substring(0, 64);
    }

    /** 派生内容の説明。プラグイン由来なら id と版を必ず含める（機械可読な出所）。 */
    static String derivationDescription(DerivedSeriesRequest req) {
        String base = req.derivationDescription() != null && !req.derivationDescription().isBlank()
                ? req.derivationDescription().trim()
                : (req.producer() != null ? "Plugin output" : "Oblique reslice (GRAPHY-Next Slicer)");
        DerivedSeriesRequest.Producer p = req.producer();
        if (p == null) {
            return base;
        }
        String ver = p.version() != null && !p.version().isBlank() ? " " + p.version() : "";
        return base + " (GRAPHY-Next plugin: " + p.id() + ver + ")";
    }

    /** Part-10 一時ファイルに書き出してから保管庫へ取り込む。 */
    private void ingest(Attributes attrs) throws IOException {
        Path tmp = Files.createTempFile("derived-", ".dcm");
        boolean consumed = false;
        try {
            Attributes fmi = attrs.createFileMetaInformation(UID.ExplicitVRLittleEndian);
            try (DicomOutputStream dos = new DicomOutputStream(tmp.toFile())) {
                dos.writeDataset(fmi, attrs);
            }
            storage.ingest(tmp); // 成功時 tmp は正規パスへ移動
            consumed = true;
        } finally {
            if (!consumed) {
                Files.deleteIfExists(tmp);
            }
        }
    }
}

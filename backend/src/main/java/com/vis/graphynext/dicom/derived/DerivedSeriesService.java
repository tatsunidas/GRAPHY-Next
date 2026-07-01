/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.derived;

import com.vis.graphynext.dicom.store.DicomStorageService;
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

    private final DicomStorageService storage;

    public DerivedSeriesService(DicomStorageService storage) {
        this.storage = storage;
    }

    /** 生成結果。 */
    public record Result(String seriesInstanceUid, List<String> sopInstanceUids) {}

    /** 元シリーズ属性を引き継いで派生シリーズを生成・保存する。 */
    public Result create(DerivedSeriesRequest req) throws IOException {
        validate(req);

        // 属性テンプレート = 元シリーズの代表インスタンスのヘッダ。
        List<Path> srcFiles = storage.resolveFiles(req.studyInstanceUid(), List.of(req.seriesInstanceUid()));
        if (srcFiles.isEmpty()) {
            throw new IllegalArgumentException("元シリーズが見つかりません (study=" + req.studyInstanceUid()
                    + ", series=" + req.seriesInstanceUid() + ")");
        }
        Attributes tmpl = readHeader(srcFiles.get(0));

        String newSeriesUid = UIDUtils.createUID();
        int seriesNumber = req.seriesNumber() != null ? req.seriesNumber()
                : tmpl.getInt(Tag.SeriesNumber, 0) + 1000;
        String modality = tmpl.getString(Tag.Modality, "OT");

        int expectedBytes = req.rows() * req.columns() * 2;
        List<String> sops = new ArrayList<>(req.frames().size());
        for (DerivedSeriesRequest.Frame f : req.frames()) {
            byte[] px = Base64.getDecoder().decode(f.pixels());
            if (px.length != expectedBytes) {
                throw new IllegalArgumentException("画素バイト長が rows*columns*2 と一致しません (instance="
                        + f.instanceNumber() + ", got=" + px.length + ", expected=" + expectedBytes + ")");
            }
            Attributes a = buildInstance(tmpl, req, newSeriesUid, seriesNumber, modality, f, px);
            sops.add(a.getString(Tag.SOPInstanceUID));
            ingest(a);
        }
        log.info("derived series created: {} ({} instances) from {}", newSeriesUid, sops.size(),
                req.seriesInstanceUid());
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

        // 患者/検査属性を元シリーズから個別に確実に引き継ぐ。
        int[] inherit = {
                Tag.SpecificCharacterSet,
                Tag.PatientID, Tag.PatientName, Tag.PatientBirthDate, Tag.PatientSex, Tag.PatientAge,
                Tag.StudyInstanceUID, Tag.StudyDate, Tag.StudyTime, Tag.StudyID,
                Tag.AccessionNumber, Tag.StudyDescription, Tag.ReferringPhysicianName,
                Tag.Manufacturer, Tag.ManufacturerModelName,
                Tag.PatientPosition,
                Tag.WindowCenter, Tag.WindowWidth, Tag.VOILUTFunction,
        };
        for (int tag : inherit) {
            copyTag(tmpl, a, tag);
        }
        // FrameOfReferenceUID は幾何がある場合のみ引き継ぐ（IPP/IOP 無しで付けると空間登録を偽装するため）。
        if (hasGeom) {
            copyTag(tmpl, a, Tag.FrameOfReferenceUID);
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
        a.setString(Tag.SeriesDescription, VR.LO,
                req.seriesDescription() != null ? req.seriesDescription() : "Reslice");

        // インスタンス（新規）。
        a.setString(Tag.SOPInstanceUID, VR.UI, UIDUtils.createUID());
        a.setInt(Tag.InstanceNumber, VR.IS, f.instanceNumber());
        // 幾何ありは平面リスライス（RESLICE）、幾何なしは曲面/平坦化再構成（DERIVED\SECONDARY のみ）。
        if (hasGeom) {
            a.setString(Tag.ImageType, VR.CS, "DERIVED", "SECONDARY", "RESLICE");
        } else {
            a.setString(Tag.ImageType, VR.CS, "DERIVED", "SECONDARY");
        }
        String derivation = req.derivationDescription() != null && !req.derivationDescription().isBlank()
                ? req.derivationDescription()
                : "Oblique reslice (GRAPHY-Next Slicer)";
        a.setString(Tag.DerivationDescription, VR.ST, derivation);
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
        // 値はそのまま（フロントの volume 値＝CT は HU）→ Rescale は恒等。
        a.setDouble(Tag.RescaleIntercept, VR.DS, 0.0);
        a.setDouble(Tag.RescaleSlope, VR.DS, 1.0);
        if ("CT".equalsIgnoreCase(modality)) {
            a.setString(Tag.RescaleType, VR.LO, "HU");
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

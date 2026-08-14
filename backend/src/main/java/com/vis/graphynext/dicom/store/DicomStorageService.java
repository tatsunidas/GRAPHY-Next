/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import com.vis.graphynext.dicom.DicomProperties;
import com.vis.graphynext.dicom.SeriesLayoutBuilder;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.List;

/**
 * ローカル保管庫（FS）＋索引（H2）への取り込みと検索。
 *
 * <p>設計方針:
 * <ol>
 *   <li>保存と索引を 1 トランザクションに。索引書き込みに失敗したら例外でロールバックし、
 *       置いたファイルも削除して<b>孤児ファイルを残さない</b>（GRAPHY の C-STORE 不整合を回避）。</li>
 *   <li>主キー=SOPInstanceUID により再受信は upsert で<b>冪等</b>。</li>
 *   <li>検索はリポジトリの 1 クエリに委譲。</li>
 *   <li>索引には FS ファイルへの {@code file:} URI を保持。</li>
 * </ol>
 */
@Service
public class DicomStorageService {

    private static final Logger log = LoggerFactory.getLogger(DicomStorageService.class);

    private final DicomInstanceRepository repo;
    private final Path storageDir;

    public DicomStorageService(DicomInstanceRepository repo, DicomProperties props) {
        this.repo = repo;
        this.storageDir = Paths.get(props.getStorageDir());
    }

    /**
     * 一時 DICOM Part-10 ファイルを取り込む（メタデータ解析 → 正規パスへ移動 → 索引登録）。
     * 成功時、一時ファイルは正規パスへ移動済み（残らない）。
     */
    @Transactional
    public DicomInstance ingest(Path tempFile) throws IOException {
        Attributes fmi;
        Attributes ds;
        try (DicomInputStream in = new DicomInputStream(tempFile.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            fmi = in.readFileMetaInformation();
            ds = in.readDatasetUntilPixelData();
        }

        String iuid = value(fmi, Tag.MediaStorageSOPInstanceUID, ds, Tag.SOPInstanceUID);
        String cuid = value(fmi, Tag.MediaStorageSOPClassUID, ds, Tag.SOPClassUID);
        String tsuid = fmi != null ? fmi.getString(Tag.TransferSyntaxUID) : UID.ExplicitVRLittleEndian;
        String patientId = ds.getString(Tag.PatientID, "");
        String studyUid = ds.getString(Tag.StudyInstanceUID);
        String seriesUid = ds.getString(Tag.SeriesInstanceUID);

        if (iuid == null || studyUid == null || seriesUid == null) {
            throw new IOException("必須 UID が欠落しています (sop=" + iuid + ", study=" + studyUid + ", series=" + seriesUid + ")");
        }

        Path dest = storageDir.resolve(Paths.get(studyUid, seriesUid, iuid + ".dcm"));
        Files.createDirectories(dest.getParent());
        // 冪等: 同一 SOPInstanceUID の再受信は上書き
        Files.move(tempFile, dest, StandardCopyOption.REPLACE_EXISTING);

        DicomInstance entity = new DicomInstance(iuid);
        entity.setSopClassUid(cuid);
        entity.setTransferSyntaxUid(tsuid);
        entity.setPatientId(patientId);
        entity.setPatientName(ds.getString(Tag.PatientName));
        entity.setPatientBirthDate(ds.getString(Tag.PatientBirthDate));
        entity.setPatientSex(ds.getString(Tag.PatientSex));
        entity.setStudyInstanceUid(studyUid);
        entity.setStudyDate(ds.getString(Tag.StudyDate));
        entity.setStudyDescription(ds.getString(Tag.StudyDescription));
        entity.setAccessionNumber(ds.getString(Tag.AccessionNumber));
        entity.setSeriesInstanceUid(seriesUid);
        entity.setModality(ds.getString(Tag.Modality));
        entity.setSeriesNumber(ds.getInt(Tag.SeriesNumber, 0));
        entity.setSeriesDescription(ds.getString(Tag.SeriesDescription));
        entity.setInstanceNumber(ds.getInt(Tag.InstanceNumber, 0));
        entity.setSizeBytes(Files.size(dest));
        entity.setUri(dest.toUri().toString());
        try {
            DicomInstance saved = repo.save(entity);
            log.debug("indexed sop={} study={} -> {}", iuid, studyUid, dest); // 検証済み: 大量取込で冗長なため DEBUG
            return saved;
        } catch (RuntimeException ex) {
            // 索引に載らないファイルを残さない（トランザクションはロールバックされる）
            try {
                Files.deleteIfExists(dest);
            } catch (IOException ignore) {
                // ベストエフォート
            }
            log.warn("INDEX failed, rolled back and deleted file: {}", dest, ex);
            throw ex;
        }
    }

    /**
     * ローカルファイルを取り込む（原本はコピーして保持。ingest は temp を消費するため一時複製を使う）。
     */
    public DicomInstance importFromFile(Path source) throws IOException {
        Path tmpDir = storageDir.resolve(".import");
        Files.createDirectories(tmpDir);
        Path tmp = Files.createTempFile(tmpDir, "imp-", ".dcm");
        try {
            Files.copy(source, tmp, StandardCopyOption.REPLACE_EXISTING);
            return ingest(tmp); // 成功時 tmp は dest へ移動、失敗時は ingest 内で後始末
        } catch (IOException | RuntimeException e) {
            try {
                Files.deleteIfExists(tmp);
            } catch (IOException ignore) {
                // ベストエフォート
            }
            throw e;
        }
    }

    @Transactional(readOnly = true)
    public List<DicomInstance> findMatches(String patientId, String studyUid, String seriesUid, String sopUid) {
        return repo.findMatches(patientId, studyUid, seriesUid, sopUid);
    }

    /** スタディ（seriesUid != null ならそのシリーズ）のローカル保存インスタンス数（QR の保存済み判定用）。 */
    @Transactional(readOnly = true)
    public long storedCount(String studyUid, String seriesUid) {
        if (seriesUid != null && !seriesUid.isBlank()) {
            return repo.countByStudyInstanceUidAndSeriesInstanceUid(studyUid, seriesUid);
        }
        return repo.countByStudyInstanceUid(studyUid);
    }

    /** ローカル索引のスタディ一覧（全件）。 */
    @Transactional(readOnly = true)
    public List<com.vis.graphynext.dicom.StudyDto> listStudies() {
        return listStudies(new com.vis.graphynext.dicom.StudySearch(null, null, null, null, null, null));
    }

    /** ローカル索引のスタディ一覧（絞り込み）。 */
    @Transactional(readOnly = true)
    public List<com.vis.graphynext.dicom.StudyDto> listStudies(com.vis.graphynext.dicom.StudySearch search) {
        com.vis.graphynext.dicom.StudySearch s = search.normalized();
        // modality はカンマ区切り→IN リスト。空なら filterModality=false（IN は使わずダミー1件で SQL を成立させる）。
        java.util.List<String> modalities = s.modality() == null ? java.util.List.of()
                : java.util.Arrays.stream(s.modality().split(",")).map(String::trim)
                        .filter(m -> !m.isEmpty()).toList();
        boolean filterModality = !modalities.isEmpty();
        // モダリティ未指定時のダミー値。実モダリティと絶対に一致しない値が要る（IN 句が空だと SQL エラー）。
        // ⚠ 生の NUL 文字をソースに書くと grep/rg がこのファイルをバイナリ扱いして**検索から丸ごと漏れる**
        //   （実際に listSeries が見つからず調査が空振りした）。必ずエスケープで書くこと。
        java.util.List<String> modParam = filterModality ? modalities : java.util.List.of("\0");
        return repo.findStudySummaries(s.patientId(), s.patientName(), s.studyDateFrom(), s.studyDateTo(),
                        filterModality, modParam, s.accessionNumber()).stream()
                .map(x -> new com.vis.graphynext.dicom.StudyDto(
                        x.getStudyInstanceUid(), x.getPatientId(), x.getPatientName(),
                        x.getStudyDate(), x.getStudyDescription(), x.getModality(),
                        x.getNumberOfInstances()))
                .toList();
    }

    /** スタディ内のシリーズ一覧。 */
    @Transactional(readOnly = true)
    public List<com.vis.graphynext.dicom.SeriesDto> listSeries(String studyUid) {
        return repo.findSeriesSummaries(studyUid).stream()
                .map(s -> new com.vis.graphynext.dicom.SeriesDto(
                        s.getSeriesInstanceUid(), s.getModality(), s.getSeriesNumber(),
                        s.getSeriesDescription(), s.getSopClassUid(), s.getNumberOfInstances()))
                .toList();
    }

    /** シリーズ内のインスタンス一覧。 */
    @Transactional(readOnly = true)
    public List<com.vis.graphynext.dicom.InstanceDto> listInstances(String studyUid, String seriesUid) {
        return repo.findBySeries(studyUid, seriesUid).stream()
                .map(i -> new com.vis.graphynext.dicom.InstanceDto(
                        i.getSopInstanceUid(), i.getInstanceNumber(), i.getSopClassUid()))
                .toList();
    }

    /**
     * 指定 study/series/sop に対応する保管パスを返す（ingest と同じ規約
     * {@code <storageDir>/<studyUid>/<seriesUid>/<sopUid>.dcm}）。シリーズ統合/分割の移動先算出に使う。
     */
    public Path instanceStoragePath(String studyUid, String seriesUid, String sopUid) {
        return storageDir.resolve(Paths.get(studyUid, seriesUid, sopUid + ".dcm"));
    }

    /**
     * 指定スタディ（必要ならシリーズで絞り込み）に属するインスタンスのローカル DICOM ファイルパス一覧を返す。
     * DICOM Send（C-STORE SCU）が送信対象を解決するために使う。索引に無い／{@code file:} でない／実在しない
     * ものは除外する。{@code seriesUids} が null/空ならスタディ全体。
     */
    @Transactional(readOnly = true)
    public List<Path> resolveFiles(String studyUid, List<String> seriesUids) {
        List<DicomInstance> insts;
        if (seriesUids == null || seriesUids.isEmpty()) {
            insts = repo.findByStudyInstanceUid(studyUid);
        } else {
            insts = new java.util.ArrayList<>();
            for (String se : seriesUids) {
                insts.addAll(repo.findBySeries(studyUid, se));
            }
        }
        return insts.stream()
                .map(DicomInstance::getUri)
                .filter(u -> u != null && u.startsWith("file:"))
                .map(u -> Path.of(java.net.URI.create(u)))
                .filter(Files::exists)
                .toList();
    }

    /**
     * sopUid のローカル DICOM ファイルパスを返す（索引に無い／URI が file: でない場合は null）。
     * 2D ビューア（standalone）が wadouri で読むための Part-10 配信に使う。
     */
    @Transactional(readOnly = true)
    public Path resolveInstanceFile(String sopUid) {
        return repo.findById(sopUid)
                .map(DicomInstance::getUri)
                .filter(u -> u != null && u.startsWith("file:"))
                .map(u -> Path.of(java.net.URI.create(u)))
                .filter(Files::exists)
                .orElse(null);
    }

    /**
     * シリーズの 5D(ZCT) レイアウトを導出する。各インスタンスのヘッダ（ピクセル無し）を読み、
     * IPP/IOP → Z、Temporal/Trigger → T、Echo/Bvalue/EchoTime → C を {@link SeriesLayoutBuilder} で組む。
     * Fusion 精密アライメント用に IOP・PixelSpacing・ZSpatial（Z インデックス → IPP）も付与する。
     */
    @Transactional(readOnly = true)
    public com.vis.graphynext.dicom.SeriesLayout seriesLayout(String studyUid, String seriesUid) {
        java.util.List<DicomInstance> insts = repo.findBySeries(studyUid, seriesUid);
        // Siemens モザイク（1 インスタンスに全スライスをタイル化）はデモザイクして Z×T に展開する。
        com.vis.graphynext.dicom.SeriesLayout mosaic = mosaicLayoutIfApplicable(insts);
        if (mosaic != null) {
            return mosaic;
        }
        // DICOM SEG（マルチフレーム）は per-frame 解析して 各セグメント=C・各スライス=Z に展開する。
        com.vis.graphynext.dicom.SeriesLayout seg = segLayoutIfApplicable(insts);
        if (seg != null) {
            return seg;
        }
        // XA/XRF の古典マルチフレーム（シネ）は ラン=Z・フレーム=T に展開する（fw/angio-design.md §5.2）。
        com.vis.graphynext.dicom.SeriesLayout xa = xaLayoutIfApplicable(insts);
        if (xa != null) {
            return xa;
        }
        java.util.List<SeriesLayoutBuilder.FrameMeta> frames = new java.util.ArrayList<>();
        // Fusion 空間メタ収集
        double[] seriesIop = null;
        double seriesPxRow = 0, seriesPxCol = 0;
        int seriesWidth = 0, seriesHeight = 0;
        String seriesFor = null;
        // ボリューム構築前のメモリ量予測用（fw/volume-memory-guard.md V2）。
        com.vis.graphynext.dicom.SeriesLayout.PixelFormat seriesPixelFormat = null;
        java.util.Map<String, double[]> sopToIpp = new java.util.HashMap<>();
        // 複数オリエンテーション検出（3-plane localizer 等）。IOP が混在するシリーズは
        // 空間ボリュームではないため zpos（=IPP·各自の法線、軸が異なり無意味）でソートせず、
        // instance 順の純スタックにする（並び替えによる再 init・部分表示を防ぐ）。
        java.util.Set<String> iopKeys = new java.util.LinkedHashSet<>();

        for (DicomInstance inst : insts) {
            int instNo = inst.getInstanceNumber() != null ? inst.getInstanceNumber() : 0;
            Attributes ds = readHeaderQuietly(inst);
            if (ds == null) {
                frames.add(new SeriesLayoutBuilder.FrameMeta(inst.getSopInstanceUid(), instNo, instNo, java.util.Map.of()));
                continue;
            }
            double zpos = zPosition(ds, instNo);
            java.util.Map<String, Double> dims = new java.util.HashMap<>();
            // T(時間): クラシック単一フレームは TemporalPositionIdentifier(0020,0100) を優先し、
            // 無ければ TemporalPositionIndex(0020,9128) をフォールバックで読む（両対応）。
            // ※ Enhanced 多フレーム（1 インスタンスに多数フレーム）の per-frame Index 解析は TODO #8。
            putFirstPresent(dims, "Temporal", ds, Tag.TemporalPositionIdentifier, Tag.TemporalPositionIndex);
            putIfPresent(dims, "Trigger", ds, Tag.TriggerTime);
            // C(チャンネル)=同一位置・同一時相で見ているものが違う: Echo/b値/EchoTime/位相成分。
            putIfPresent(dims, "Echo", ds, Tag.EchoNumbers);
            putIfPresent(dims, "Bvalue", ds, Tag.DiffusionBValue);
            putIfPresent(dims, "EchoTime", ds, Tag.EchoTime);
            putComplexComponent(dims, ds); // ComplexImageComponent(MAGNITUDE/PHASE/REAL/IMAGINARY) → "Complex"
            // T(時間)=繰り返し/経時。AcquisitionNumber は「一定時間の連続データ収集」＝本質的に時間軸。
            putIfPresent(dims, "Acq", ds, Tag.AcquisitionNumber);
            frames.add(new SeriesLayoutBuilder.FrameMeta(inst.getSopInstanceUid(), instNo, zpos, dims));

            // 空間メタ（最初の有効インスタンスから取得）
            double[] ipp = ds.getDoubles(Tag.ImagePositionPatient);
            if (ipp != null && ipp.length >= 3) {
                sopToIpp.put(inst.getSopInstanceUid(), ipp);
            }
            double[] iop = ds.getDoubles(Tag.ImageOrientationPatient);
            if (iop != null && iop.length >= 6) {
                iopKeys.add(iopKey(iop));
                if (seriesIop == null) seriesIop = iop;
            }
            if (seriesPxRow == 0) {
                double[] ps = ds.getDoubles(Tag.PixelSpacing);
                if (ps != null && ps.length >= 2) { seriesPxRow = ps[0]; seriesPxCol = ps[1]; }
            }
            if (seriesWidth == 0) {
                int w = ds.getInt(Tag.Columns, 0);
                int h = ds.getInt(Tag.Rows, 0);
                if (w > 0 && h > 0) { seriesWidth = w; seriesHeight = h; }
            }
            if (seriesFor == null) {
                String fr = ds.getString(Tag.FrameOfReferenceUID);
                if (fr != null && !fr.isBlank()) seriesFor = fr;
            }
            // 予測式が standalone / web で一致している必要があるため、抽出は web 側と同じ 1 本を使う。
            if (seriesPixelFormat == null) {
                seriesPixelFormat = com.vis.graphynext.dicom.SeriesLayoutAssembler.readPixelFormat(ds);
            }
        }

        // 複数オリエンテーション（localizer/scout 等）: 並び替えず instance 順の純スタックにする。
        boolean mixedOrientation = iopKeys.size() > 1;
        if (mixedOrientation) {
            java.util.List<SeriesLayoutBuilder.FrameMeta> seq = new java.util.ArrayList<>(frames.size());
            for (SeriesLayoutBuilder.FrameMeta f : frames) {
                seq.add(new SeriesLayoutBuilder.FrameMeta(
                        f.sopInstanceUid(), f.instanceNumber(), f.instanceNumber(), java.util.Map.of()));
            }
            frames = seq;
        }

        com.vis.graphynext.dicom.SeriesLayout basic = SeriesLayoutBuilder.build(frames);

        // Z インデックス → IPP マッピング（z 昇順）。混在オリエンテーションでは Z 軸が無意味なため付与しない。
        java.util.List<com.vis.graphynext.dicom.SeriesLayout.ZSpatial> zSpatials = null;
        if (!mixedOrientation && !sopToIpp.isEmpty() && basic.nZ() > 0) {
            java.util.Map<Integer, double[]> zToIpp = new java.util.TreeMap<>();
            for (com.vis.graphynext.dicom.SeriesLayout.Cell cell : basic.cells()) {
                if (!zToIpp.containsKey(cell.z())) {
                    double[] ipp = sopToIpp.get(cell.sopInstanceUid());
                    if (ipp != null) zToIpp.put(cell.z(), ipp);
                }
            }
            if (!zToIpp.isEmpty()) {
                zSpatials = new java.util.ArrayList<>();
                for (java.util.Map.Entry<Integer, double[]> e : zToIpp.entrySet()) {
                    zSpatials.add(new com.vis.graphynext.dicom.SeriesLayout.ZSpatial(e.getKey(), e.getValue()));
                }
            }
        }

        return new com.vis.graphynext.dicom.SeriesLayout(
                basic.nZ(), basic.nC(), basic.nT(),
                basic.cDimension(), basic.tDimension(), basic.cells(),
                seriesIop, seriesPxRow, seriesPxCol, seriesWidth, seriesHeight,
                zSpatials, seriesFor, seriesPixelFormat, null);
    }

    /**
     * XA/XRF の古典マルチフレーム（シネ）レイアウト。対象が無ければ null（従来経路へ）。
     * ロジックは web モードと共有（{@link com.vis.graphynext.dicom.XaFrameExpander}）。
     */
    private com.vis.graphynext.dicom.SeriesLayout xaLayoutIfApplicable(java.util.List<DicomInstance> insts) {
        java.util.List<Attributes> headers = new java.util.ArrayList<>();
        for (DicomInstance inst : insts) {
            Attributes ds = readHeaderQuietly(inst);
            if (ds != null) {
                headers.add(ds);
            }
        }
        com.vis.graphynext.dicom.SeriesLayout xa = com.vis.graphynext.dicom.XaFrameExpander.layout(headers);
        if (xa != null) {
            log.debug("XA cine series: runs={} frames={}", xa.nZ(), xa.nT());
        }
        return xa;
    }

    /** Siemens 私的タグ NumberOfImagesInMosaic (0019,100a)。 */
    private static final int TAG_NUMBER_OF_IMAGES_IN_MOSAIC = 0x0019100A;

    /** ImageType に "MOSAIC" を含むか（Siemens モザイク判定。Praparat 準拠）。 */
    private static boolean isMosaic(Attributes ds) {
        if (ds == null) {
            return false;
        }
        String[] types = ds.getStrings(Tag.ImageType);
        if (types != null) {
            for (String t : types) {
                if (t != null && t.trim().equalsIgnoreCase("MOSAIC")) {
                    return true;
                }
            }
            return false;
        }
        String it = ds.getString(Tag.ImageType, "");
        return it != null && it.toUpperCase().contains("MOSAIC");
    }

    /**
     * NumberOfImagesInMosaic を堅牢に読む。直接 (0019,100a) を試し、ダメなら group 0019 の
     * 私的クリエータ（SIEMENS …）ブロックを走査して該当要素 (0019,bb0a) を読む。無ければ -1。
     */
    private static int numberOfImagesInMosaic(Attributes ds) {
        int n = ds.getInt(TAG_NUMBER_OF_IMAGES_IN_MOSAIC, -1);
        if (n > 0) {
            return n;
        }
        for (int block = 0x10; block <= 0xff; block++) {
            int creatorTag = (0x0019 << 16) | block; // (0019,00bb) 私的クリエータ
            String creator = ds.getString(creatorTag);
            if (creator != null && creator.toUpperCase().contains("SIEMENS")) {
                int elemTag = (0x0019 << 16) | (block << 8) | 0x0a; // (0019,bb0a)
                int v = ds.getInt(elemTag, -1);
                if (v > 0) {
                    return v;
                }
            }
        }
        return -1;
    }

    /**
     * モザイクシリーズなら、デモザイクした Z(タイル)×T(時相) レイアウトを返す。非モザイクなら null。
     *
     * <p>GRAPHY Praparat 準拠: タイル数 N=NumberOfImagesInMosaic(0019,100a)、grid=ceil(√N)、
     * tileW=Cols/grid・tileH=Rows/grid、per-slice IPP = mosaicIPP + index·spacing·normal
     * （normal=IOP 外積・正規化、spacing=SpacingBetweenSlices→SliceThickness→1.0）。
     * 各モザイクインスタンス=1 時相、N タイル=Z スライス。フレーム配信は
     * {@code /instances/{sop}/frames/{tile}/file} がタイルを切り出して返す。
     */
    private com.vis.graphynext.dicom.SeriesLayout mosaicLayoutIfApplicable(java.util.List<DicomInstance> insts) {
        if (insts.isEmpty()) {
            return null;
        }
        // 先頭の読める1枚でモザイク判定＋幾何を取得。
        Attributes head = null;
        for (DicomInstance inst : insts) {
            Attributes ds = readHeaderQuietly(inst);
            if (ds != null) {
                head = ds;
                break;
            }
        }
        if (head == null) {
            return null;
        }
        // ImageType に MOSAIC が無ければ非モザイク（NumberOfImagesInMosaic 私的タグの有無に依存しない）。
        // localizer 等が当該私的タグを持つ／creator ブロック走査が誤検出するケースでの誤デモザイクを防ぐ。
        if (!isMosaic(head)) {
            return null;
        }
        int numImages = numberOfImagesInMosaic(head);
        int mosaicCols = head.getInt(Tag.Columns, 0);
        int mosaicRows = head.getInt(Tag.Rows, 0);
        if (numImages <= 0 || mosaicCols <= 0 || mosaicRows <= 0) {
            log.warn("layout: MOSAIC だが NumberOfImagesInMosaic/Rows/Columns が不正 (N={} {}x{})",
                    numImages, mosaicCols, mosaicRows);
            return null;
        }
        int grid = (int) Math.ceil(Math.sqrt(numImages));
        int tileW = mosaicCols / grid;
        int tileH = mosaicRows / grid;
        if (tileW <= 0 || tileH <= 0) {
            return null;
        }

        // 空間メタ（先頭から）。per-tile IPP 算出用に normal/spacing/IPP/IOP。
        double[] iop = head.getDoubles(Tag.ImageOrientationPatient);
        double[] mosaicIpp = head.getDoubles(Tag.ImagePositionPatient);
        double spacing = head.getDouble(Tag.SpacingBetweenSlices,
                head.getDouble(Tag.SliceThickness, 1.0));
        double[] ps = head.getDoubles(Tag.PixelSpacing);
        double pxRow = (ps != null && ps.length >= 2) ? ps[0] : 0;
        double pxCol = (ps != null && ps.length >= 2) ? ps[1] : 0;
        double nx = 0, ny = 0, nz = 1;
        if (iop != null && iop.length == 6) {
            double tnx = iop[1] * iop[5] - iop[2] * iop[4];
            double tny = iop[2] * iop[3] - iop[0] * iop[5];
            double tnz = iop[0] * iop[4] - iop[1] * iop[3];
            double len = Math.sqrt(tnx * tnx + tny * tny + tnz * tnz);
            if (len > 0) {
                nx = tnx / len;
                ny = tny / len;
                nz = tnz / len;
            }
        }

        // 各モザイクインスタンス（=繰り返し=時相）を順序付け（TemporalPositionIdentifier/Index →
        // AcquisitionNumber → InstanceNumber）。各モザイク=1 時相、N タイル=Z スライス。
        record TP(DicomInstance inst, double order) {
        }
        java.util.List<TP> tps = new java.util.ArrayList<>();
        for (DicomInstance inst : insts) {
            Attributes ds = readHeaderQuietly(inst);
            if (ds == null) {
                continue;
            }
            Double ord = readNumeric(ds, Tag.TemporalPositionIdentifier);
            if (ord == null) ord = readNumeric(ds, Tag.TemporalPositionIndex);
            if (ord == null) ord = readNumeric(ds, Tag.AcquisitionNumber);
            if (ord == null) {
                ord = (double) (inst.getInstanceNumber() != null ? inst.getInstanceNumber() : 0);
            }
            tps.add(new TP(inst, ord));
        }
        tps.sort(java.util.Comparator.comparingDouble(TP::order)
                .thenComparing(t -> t.inst().getInstanceNumber() != null ? t.inst().getInstanceNumber() : 0));

        // Z=タイル（スライス）, T=繰り返し（時相）, C=1。
        int nT = tps.size();
        int nC = 1;
        int nZ = numImages;
        java.util.List<com.vis.graphynext.dicom.SeriesLayout.Cell> cells = new java.util.ArrayList<>();
        for (int t = 0; t < nT; t++) {
            String sop = tps.get(t).inst().getSopInstanceUid();
            for (int k = 0; k < numImages; k++) {
                cells.add(new com.vis.graphynext.dicom.SeriesLayout.Cell(0, k, t, sop, k));
            }
        }

        // zSpatial: タイル k の IPP = mosaicIPP + k·spacing·normal（Praparat 準拠）。
        java.util.List<com.vis.graphynext.dicom.SeriesLayout.ZSpatial> zSpatials = null;
        if (mosaicIpp != null && mosaicIpp.length == 3) {
            zSpatials = new java.util.ArrayList<>();
            for (int k = 0; k < numImages; k++) {
                double[] ippK = {
                        mosaicIpp[0] + nx * spacing * k,
                        mosaicIpp[1] + ny * spacing * k,
                        mosaicIpp[2] + nz * spacing * k,
                };
                zSpatials.add(new com.vis.graphynext.dicom.SeriesLayout.ZSpatial(k, ippK));
            }
        }

        String tDim = nT > 1 ? "Temporal" : null;
        log.debug("MOSAIC series: N(tiles)={} grid={} tile={}x{} -> nZ={} nC={} nT={}",
                numImages, grid, tileW, tileH, nZ, nC, nT);
        return new com.vis.graphynext.dicom.SeriesLayout(
                nZ, nC, nT, null, tDim, cells,
                iop, pxRow, pxCol, tileW, tileH, zSpatials, head.getString(Tag.FrameOfReferenceUID),
                com.vis.graphynext.dicom.SeriesLayoutAssembler.readPixelFormat(head), null);
    }

    /**
     * モザイク 1 タイルを単一フレーム DICOM (Part-10, Explicit VR LE) として生成して返す。
     * frontend は {@code wadouri:.../instances/{sop}/frames/{tile}/file} で通常画像として読む。
     * 非圧縮トランスファシンタックスのみ対応（圧縮はピクセルが encapsulated のため null）。
     * 切り出し: タイル (col=frame%grid, row=frame/grid) の tileW×tileH を行単位コピー。
     * per-tile IPP = mosaicIPP + frame·spacing·normal（Praparat 準拠）。
     */
    @Transactional(readOnly = true)
    public byte[] mosaicTileDicom(String sopUid, int frame) {
        Path path = resolveInstanceFile(sopUid);
        if (path == null) {
            return null;
        }
        try (DicomInputStream in = new DicomInputStream(path.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.YES);
            in.readFileMetaInformation();
            Attributes ds = in.readDataset(-1, -1);
            String tsuid = in.getTransferSyntax();
            if (tsuid == null || !(tsuid.equals(org.dcm4che3.data.UID.ImplicitVRLittleEndian)
                    || tsuid.equals(org.dcm4che3.data.UID.ExplicitVRLittleEndian)
                    || tsuid.equals(org.dcm4che3.data.UID.ExplicitVRBigEndian))) {
                log.warn("mosaic tile: 圧縮 TS は未対応 {}", tsuid);
                return null;
            }
            int numImages = numberOfImagesInMosaic(ds);
            int cols = ds.getInt(Tag.Columns, 0);
            int rows = ds.getInt(Tag.Rows, 0);
            if (numImages <= 0 || cols <= 0 || rows <= 0) {
                return null;
            }
            int grid = (int) Math.ceil(Math.sqrt(numImages));
            int tileW = cols / grid;
            int tileH = rows / grid;
            if (frame < 0 || frame >= numImages || tileW <= 0 || tileH <= 0) {
                return null;
            }
            int bits = ds.getInt(Tag.BitsAllocated, 16);
            int samples = ds.getInt(Tag.SamplesPerPixel, 1);
            int bps = Math.max(1, bits / 8) * samples; // 1 ピクセルあたりバイト数
            byte[] px = ds.getBytes(Tag.PixelData);
            if (px == null) {
                return null;
            }
            int col = frame % grid;
            int row = frame / grid;
            int srcStride = cols * bps;
            int tileStride = tileW * bps;
            byte[] dst = new byte[tileH * tileStride];
            for (int ty = 0; ty < tileH; ty++) {
                int srcOff = (row * tileH + ty) * srcStride + col * tileW * bps;
                if (srcOff < 0 || srcOff + tileStride > px.length) {
                    break;
                }
                System.arraycopy(px, srcOff, dst, ty * tileStride, tileStride);
            }

            // per-tile IPP（Praparat: mosaicIPP + frame·spacing·normal）。
            double[] iop = ds.getDoubles(Tag.ImageOrientationPatient);
            double[] ipp = ds.getDoubles(Tag.ImagePositionPatient);
            double spacing = ds.getDouble(Tag.SpacingBetweenSlices, ds.getDouble(Tag.SliceThickness, 1.0));
            if (ipp != null && ipp.length == 3 && iop != null && iop.length == 6) {
                double nx = iop[1] * iop[5] - iop[2] * iop[4];
                double ny = iop[2] * iop[3] - iop[0] * iop[5];
                double nz = iop[0] * iop[4] - iop[1] * iop[3];
                double len = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (len > 0) {
                    nx /= len;
                    ny /= len;
                    nz /= len;
                }
                ds.setDouble(Tag.ImagePositionPatient, org.dcm4che3.data.VR.DS,
                        ipp[0] + nx * spacing * frame,
                        ipp[1] + ny * spacing * frame,
                        ipp[2] + nz * spacing * frame);
            }
            ds.setInt(Tag.Rows, org.dcm4che3.data.VR.US, tileH);
            ds.setInt(Tag.Columns, org.dcm4che3.data.VR.US, tileW);
            ds.setBytes(Tag.PixelData, bits > 8 ? org.dcm4che3.data.VR.OW : org.dcm4che3.data.VR.OB, dst);

            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream(dst.length + 8192);
            Attributes fmi = ds.createFileMetaInformation(org.dcm4che3.data.UID.ExplicitVRLittleEndian);
            try (org.dcm4che3.io.DicomOutputStream dos =
                         new org.dcm4che3.io.DicomOutputStream(bos, org.dcm4che3.data.UID.ExplicitVRLittleEndian)) {
                dos.writeDataset(fmi, ds);
            }
            return bos.toByteArray();
        } catch (Exception e) {
            log.warn("mosaic tile 生成失敗 sop={} frame={}", sopUid, frame, e);
            return null;
        }
    }

    /**
     * シリーズの幾何（先頭インスタンス）を引き継ぎ、画素をシリーズ最小値で埋めた「ブランク（パディング）画像」を
     * 単一フレーム DICOM (Part-10) として生成する。複数スキャン混在で、ある C/T がカバーしない Z 位置の穴を
     * 物理座標に揃えて埋めるために使う（近傍画像での代用を防ぐ）。
     *
     * <p>属性は先頭インスタンスのヘッダを複製して全 Image 関連属性・Study/Series UID を引き継ぎ、
     * SOPInstanceUID は新規採番（一意）。ImagePositionPatient は穴の物理位置 {@code ipp} に差し替える。
     * 最小値: SmallestImagePixelValue → PixelPaddingValue → (WindowCenter-WindowWidth/2 を stored 換算) → 0。
     */
    @Transactional(readOnly = true)
    public byte[] blankDicom(String studyUid, String seriesUid, double[] ipp) {
        Attributes ds = null;
        for (DicomInstance inst : repo.findBySeries(studyUid, seriesUid)) {
            ds = readHeaderQuietly(inst);
            if (ds != null) {
                break;
            }
        }
        if (ds == null) {
            return null;
        }
        try {
            int rows = ds.getInt(Tag.Rows, 0);
            int cols = ds.getInt(Tag.Columns, 0);
            if (rows <= 0 || cols <= 0) {
                return null;
            }
            // SEG は表示時 8bit MONOCHROME2(0/255) に展開されるため、gap ブランクも
            // 同形式（全0=セグメント無し）で返す。1bit ヘッダの継承は不可（packing 不整合）。
            if (com.vis.graphynext.dicom.SegFrameExpander.isSegDataset(ds)) {
                return segBlankDicom(ds, rows, cols, ipp);
            }
            int bits = ds.getInt(Tag.BitsAllocated, 16);
            int samples = ds.getInt(Tag.SamplesPerPixel, 1);

            // シリーズ最小値（stored 値）。ヘッダのみから決定（画素デコードはしない）。
            double slope = readNumeric(ds, Tag.RescaleSlope) != null ? readNumeric(ds, Tag.RescaleSlope) : 1.0;
            double intercept = readNumeric(ds, Tag.RescaleIntercept) != null ? readNumeric(ds, Tag.RescaleIntercept) : 0.0;
            Integer pad = null;
            if (ds.contains(Tag.SmallestImagePixelValue)) {
                pad = ds.getInt(Tag.SmallestImagePixelValue, 0);
            } else if (ds.contains(Tag.PixelPaddingValue)) {
                pad = ds.getInt(Tag.PixelPaddingValue, 0);
            } else {
                Double wc = readNumeric(ds, Tag.WindowCenter);
                Double ww = readNumeric(ds, Tag.WindowWidth);
                if (wc != null && ww != null) {
                    double floorOut = wc - ww / 2.0;
                    pad = (int) Math.round((floorOut - intercept) / (slope == 0 ? 1 : slope));
                } else {
                    pad = 0;
                }
            }

            int nSamples = rows * cols * samples;
            int bytesPerSample = Math.max(1, bits / 8);
            byte[] px = new byte[nSamples * bytesPerSample];
            if (bytesPerSample >= 2) {
                short v = (short) (int) pad; // 16bit（符号は two's complement でそのまま）
                for (int i = 0; i < nSamples; i++) {
                    px[i * 2] = (byte) (v & 0xff);
                    px[i * 2 + 1] = (byte) ((v >> 8) & 0xff);
                }
            } else {
                byte v = (byte) (int) pad;
                java.util.Arrays.fill(px, v);
            }

            // 先頭インスタンスの属性を引き継ぎつつ、ブランク用に差し替える。
            ds.setString(Tag.SOPInstanceUID, org.dcm4che3.data.VR.UI, org.dcm4che3.util.UIDUtils.createUID());
            if (ipp != null && ipp.length == 3) {
                ds.setDouble(Tag.ImagePositionPatient, org.dcm4che3.data.VR.DS, ipp);
            }
            ds.setInt(Tag.InstanceNumber, org.dcm4che3.data.VR.IS, 0);
            // 派生（DERIVED/SECONDARY）であることを示す。
            ds.setString(Tag.ImageType, org.dcm4che3.data.VR.CS, "DERIVED", "SECONDARY", "BLANK");
            ds.remove(Tag.SmallestImagePixelValue);
            ds.remove(Tag.LargestImagePixelValue);
            ds.setBytes(Tag.PixelData, bits > 8 ? org.dcm4che3.data.VR.OW : org.dcm4che3.data.VR.OB, px);

            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream(px.length + 8192);
            Attributes fmi = ds.createFileMetaInformation(org.dcm4che3.data.UID.ExplicitVRLittleEndian);
            try (org.dcm4che3.io.DicomOutputStream dos =
                         new org.dcm4che3.io.DicomOutputStream(bos, org.dcm4che3.data.UID.ExplicitVRLittleEndian)) {
                dos.writeDataset(fmi, ds);
            }
            return bos.toByteArray();
        } catch (Exception e) {
            log.warn("blank 生成失敗 series={}", seriesUid, e);
            return null;
        }
    }

    /**
     * SEG gap 用ブランク。{@link #multiFrameDicom} の BINARY 展開出力と同形式
     * （8bit MONOCHROME2, WC=127/WW=255, 全0）の単一フレーム DICOM を返す。
     */
    private byte[] segBlankDicom(Attributes src, int rows, int cols, double[] ipp) {
        try {
            byte[] outPx = new byte[rows * cols]; // 全0
            double[] iop = com.vis.graphynext.dicom.SegFrameExpander.sharedIop(src);
            double[] psp = com.vis.graphynext.dicom.SegFrameExpander.sharedPixelSpacing(src);
            Attributes out = new Attributes();
            out.setString(Tag.SOPClassUID, org.dcm4che3.data.VR.UI, org.dcm4che3.data.UID.SecondaryCaptureImageStorage);
            out.setString(Tag.SOPInstanceUID, org.dcm4che3.data.VR.UI, org.dcm4che3.util.UIDUtils.createUID());
            out.setString(Tag.StudyInstanceUID, org.dcm4che3.data.VR.UI, src.getString(Tag.StudyInstanceUID));
            out.setString(Tag.SeriesInstanceUID, org.dcm4che3.data.VR.UI, src.getString(Tag.SeriesInstanceUID));
            out.setString(Tag.Modality, org.dcm4che3.data.VR.CS, src.getString(Tag.Modality, "OT"));
            out.setInt(Tag.Rows, org.dcm4che3.data.VR.US, rows);
            out.setInt(Tag.Columns, org.dcm4che3.data.VR.US, cols);
            out.setInt(Tag.SamplesPerPixel, org.dcm4che3.data.VR.US, 1);
            out.setString(Tag.PhotometricInterpretation, org.dcm4che3.data.VR.CS, "MONOCHROME2");
            out.setInt(Tag.BitsAllocated, org.dcm4che3.data.VR.US, 8);
            out.setInt(Tag.BitsStored, org.dcm4che3.data.VR.US, 8);
            out.setInt(Tag.HighBit, org.dcm4che3.data.VR.US, 7);
            out.setInt(Tag.PixelRepresentation, org.dcm4che3.data.VR.US, 0);
            out.setInt(Tag.InstanceNumber, org.dcm4che3.data.VR.IS, 0);
            out.setString(Tag.ImageType, org.dcm4che3.data.VR.CS, "DERIVED", "SECONDARY", "BLANK");
            if (ipp != null && ipp.length == 3) out.setDouble(Tag.ImagePositionPatient, org.dcm4che3.data.VR.DS, ipp);
            if (iop != null && iop.length == 6) out.setDouble(Tag.ImageOrientationPatient, org.dcm4che3.data.VR.DS, iop);
            if (psp != null && psp.length >= 2) out.setDouble(Tag.PixelSpacing, org.dcm4che3.data.VR.DS, psp);
            out.setDouble(Tag.WindowCenter, org.dcm4che3.data.VR.DS, 127.0);
            out.setDouble(Tag.WindowWidth, org.dcm4che3.data.VR.DS, 255.0);
            out.setBytes(Tag.PixelData, org.dcm4che3.data.VR.OB, outPx);

            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream(outPx.length + 4096);
            Attributes fmi = out.createFileMetaInformation(org.dcm4che3.data.UID.ExplicitVRLittleEndian);
            try (org.dcm4che3.io.DicomOutputStream dos =
                         new org.dcm4che3.io.DicomOutputStream(bos, org.dcm4che3.data.UID.ExplicitVRLittleEndian)) {
                dos.writeDataset(fmi, out);
            }
            return bos.toByteArray();
        } catch (Exception e) {
            log.warn("SEG blank 生成失敗", e);
            return null;
        }
    }

    /**
     * フレーム配信のディスパッチ: モザイク→タイル切り出し、その他のマルチフレーム(SEG/Enhanced)→フレーム抽出。
     */
    @Transactional(readOnly = true)
    public byte[] frameDicom(String sopUid, int frame) {
        Path path = resolveInstanceFile(sopUid);
        if (path == null) {
            return null;
        }
        Attributes head;
        try (DicomInputStream in = new DicomInputStream(path.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            head = in.readDatasetUntilPixelData();
        } catch (IOException e) {
            return null;
        }
        if (head == null) {
            return null;
        }
        // ImageType に MOSAIC があるものだけタイル切り出し。それ以外は SEG/Enhanced のフレーム抽出。
        if (isMosaic(head)) {
            return mosaicTileDicom(sopUid, frame);
        }
        return multiFrameDicom(sopUid, frame);
    }

    /**
     * マルチフレーム DICOM（SEG/Enhanced）の指定フレームを単一フレーム画像として返す。
     * SEG BINARY(BitsAllocated=1) は連続 LSB-first ビット列を 8bit マスク(0/255)へ展開、
     * 8/16bit はフレームブロックをそのままコピー。per-frame IPP・共有 IOP/PixelSpacing を付与する。
     * 非圧縮 TS のみ対応。
     */
    @Transactional(readOnly = true)
    public byte[] multiFrameDicom(String sopUid, int frame) {
        Path path = resolveInstanceFile(sopUid);
        if (path == null) {
            return null;
        }
        try (DicomInputStream in = new DicomInputStream(path.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.YES);
            in.readFileMetaInformation();
            Attributes ds = in.readDataset(-1, -1);
            String ts = in.getTransferSyntax();
            if (ts == null || !(ts.equals(org.dcm4che3.data.UID.ImplicitVRLittleEndian)
                    || ts.equals(org.dcm4che3.data.UID.ExplicitVRLittleEndian)
                    || ts.equals(org.dcm4che3.data.UID.ExplicitVRBigEndian))) {
                log.warn("multiframe: 圧縮 TS は未対応 {}", ts);
                return null;
            }
            return com.vis.graphynext.dicom.SegFrameExpander.extractFrame(ds, frame);
        } catch (Exception e) {
            log.warn("multiframe 抽出失敗 sop={} frame={}", sopUid, frame, e);
            return null;
        }
    }

    /**
     * DICOM SEG（マルチフレーム）を per-frame 解析し、各セグメント=C・各スライス=Z に展開する。
     * 展開の実ロジックは {@link com.vis.graphynext.dicom.SegFrameExpander#layout} に集約し、web モード
     * （{@code SeriesLayoutAssembler}）と同一の解釈にする。各フレームは
     * {@code /instances/{sop}/frames/{i}/file} が 8bit マスク画像として返す。非 SEG なら null。
     */
    private com.vis.graphynext.dicom.SeriesLayout segLayoutIfApplicable(java.util.List<DicomInstance> insts) {
        java.util.List<Attributes> segHeaders = new java.util.ArrayList<>();
        for (DicomInstance inst : insts) {
            Attributes ds = readHeaderQuietly(inst);
            if (ds != null && com.vis.graphynext.dicom.SegFrameExpander.isSegDataset(ds)) {
                segHeaders.add(ds);
            }
        }
        com.vis.graphynext.dicom.SeriesLayout seg = com.vis.graphynext.dicom.SegFrameExpander.layout(segHeaders);
        if (seg != null) {
            log.debug("SEG series: segments={} -> nZ={} nC={}", seg.nC(), seg.nZ(), seg.nC());
        }
        return seg;
    }

    private Attributes readHeaderQuietly(DicomInstance inst) {
        Path path = (inst.getUri() != null && inst.getUri().startsWith("file:"))
                ? Path.of(java.net.URI.create(inst.getUri())) : null;
        if (path == null || !Files.exists(path)) {
            return null;
        }
        try (DicomInputStream in = new DicomInputStream(path.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.NO);
            return in.readDatasetUntilPixelData();
        } catch (IOException e) {
            log.warn("layout: header 読取失敗 {}", inst.getSopInstanceUid(), e);
            return null;
        }
    }

    /** IPP を IOP 法線へ投影した距離。無ければ SliceLocation、さらに無ければ InstanceNumber。 */
    private static double zPosition(Attributes ds, int instanceNumber) {
        double[] ipp = ds.getDoubles(Tag.ImagePositionPatient);
        double[] iop = ds.getDoubles(Tag.ImageOrientationPatient);
        if (ipp != null && ipp.length >= 3 && iop != null && iop.length >= 6) {
            double nx = iop[1] * iop[5] - iop[2] * iop[4];
            double ny = iop[2] * iop[3] - iop[0] * iop[5];
            double nz = iop[0] * iop[4] - iop[1] * iop[3];
            return ipp[0] * nx + ipp[1] * ny + ipp[2] * nz;
        }
        double sl = ds.getDouble(Tag.SliceLocation, Double.NaN);
        return Double.isNaN(sl) ? instanceNumber : sl;
    }

    /** IOP（向き）を量子化した識別キー。複数オリエンテーション（localizer 等）検出に使う。 */
    private static String iopKey(double[] iop) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 6; i++) {
            if (i > 0) sb.append(',');
            sb.append(Math.round(iop[i] * 1000.0)); // 0.001 量子化（浮動小数ノイズ吸収）
        }
        return sb.toString();
    }

    private static void putIfPresent(java.util.Map<String, Double> dims, String key, Attributes ds, int tag) {
        Double v = readNumeric(ds, tag);
        if (v != null) {
            dims.put(key, v);
        }
    }

    /**
     * ComplexImageComponent(0008,9208: MAGNITUDE/PHASE/REAL/IMAGINARY) を数値コードにして "Complex" に入れる。
     * 位相画像などを C（チャンネル）次元として扱えるようにする。
     */
    private static void putComplexComponent(java.util.Map<String, Double> dims, Attributes ds) {
        String v = ds.getString(Tag.ComplexImageComponent);
        if (v == null) {
            return;
        }
        switch (v.trim().toUpperCase()) {
            case "MAGNITUDE" -> dims.put("Complex", 0.0);
            case "PHASE" -> dims.put("Complex", 1.0);
            case "REAL" -> dims.put("Complex", 2.0);
            case "IMAGINARY" -> dims.put("Complex", 3.0);
            case "MIXED" -> { /* 混在は単一チャンネル扱い（何も入れない） */ }
            default -> { /* 未知値は無視 */ }
        }
    }

    /** 候補タグを優先順に試し、最初に存在した有効値を key に入れる（両対応の T などで使用）。 */
    private static void putFirstPresent(java.util.Map<String, Double> dims, String key, Attributes ds, int... tags) {
        for (int tag : tags) {
            Double v = readNumeric(ds, tag);
            if (v != null) {
                dims.put(key, v);
                return;
            }
        }
    }

    /**
     * 数値タグを VR 非依存で読む。{@code getString}+パースで統一する（IS/DS/US/UL/FD いずれも
     * 文字列表現が得られるため）。{@code getDouble} は VR=IS を解釈できず NaN を返すうえ
     * dcm4che が "Attempt to access ... IS as double" を都度ログ出力するので使わない。読めなければ null。
     */
    private static Double readNumeric(Attributes ds, int tag) {
        if (!ds.contains(tag)) {
            return null;
        }
        String s = ds.getString(tag);
        if (s == null) {
            return null;
        }
        s = s.trim();
        if (s.isEmpty()) {
            return null;
        }
        try {
            return Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String value(Attributes fmi, int fmiTag, Attributes ds, int dsTag) {
        if (fmi != null) {
            String v = fmi.getString(fmiTag);
            if (v != null) {
                return v;
            }
        }
        return ds.getString(dsTag);
    }
}

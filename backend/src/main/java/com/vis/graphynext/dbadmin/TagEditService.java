/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbadmin;

import com.vis.graphynext.dicom.store.DicomInstance;
import com.vis.graphynext.dicom.store.DicomInstanceRepository;
import com.vis.graphynext.dicom.store.StorageLayout;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Sequence;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomInputStream;
import org.dcm4che3.io.DicomInputStream.IncludeBulkData;
import org.dcm4che3.io.DicomOutputStream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Date;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * 任意の DICOM タグの編集（standalone のローカル保管庫）。範囲（画像・シリーズ・スタディ）の全ファイルを<b>全か無か</b>で書き換え、
 * 索引に写しのある列（{@link IndexedTag}）も合わせる。書き換えの仕組みは患者情報の編集と同じ {@link DicomFileEdit}。
 *
 * <p>変えたファイルには Original Attributes Sequence（0400,0561）を 1 項目足し、変える前の値・日時・変更したシステムを残す
 * （PS3.3 C.12.1.1.9。値の無かったタグを足したときは、空の値で記録する）。SOPInstanceUID は変えない。
 */
@Service
public class TagEditService {

    private static final Logger log = LoggerFactory.getLogger(TagEditService.class);

    static final String MODIFYING_SYSTEM = "GRAPHY-Next";

    private final DicomInstanceRepository repo;
    private final StorageLayout layout;
    private final FileRetry fileRetry = new FileRetry();
    DicomFileEdit.Ops ops = DicomFileEdit.Ops.REAL;

    public TagEditService(DicomInstanceRepository repo, StorageLayout layout) {
        this.repo = repo;
        this.layout = layout;
    }

    /** 範囲。level は instance / series / study。 */
    public record Scope(String level, String studyUid, String seriesUid, String sopUid) {
    }

    /** 1 つのタグの編集。op は set（無ければ足す）/ remove。before は画面に見えていた値（確認用）。 */
    public record Edit(String tag, String vr, String op, String before, String value) {
    }

    public record Problem(int index, String tag, String reason) {
    }

    /** 編集の中身が決まりに合わない（400）。何も書いていない。 */
    public static class InvalidEditException extends RuntimeException {
        private final List<Problem> problems;

        InvalidEditException(List<Problem> problems) {
            super("invalid-tag-edit");
            this.problems = problems;
        }

        public List<Problem> problems() {
            return problems;
        }
    }

    public record PreviewItem(String tag, int differing) {
    }

    /** files は範囲の画像数、unreadable は読めなかった数（数えに入っていない）。 */
    public record Preview(int files, int unreadable, List<PreviewItem> items) {
    }

    public record Result(int updatedFiles, List<String> indexColumns) {
    }

    /** 検査済みの編集。 */
    record CheckedEdit(int tag, VR vr, boolean remove, String[] values) {
    }

    // ── 検査 ──

    static List<CheckedEdit> check(List<Edit> edits) {
        List<Problem> problems = new ArrayList<>();
        List<CheckedEdit> out = new ArrayList<>();
        Set<Integer> seen = new HashSet<>();
        if (edits == null || edits.isEmpty()) {
            throw new InvalidEditException(List.of(new Problem(-1, "", "empty")));
        }
        for (int i = 0; i < edits.size(); i++) {
            Edit e = edits.get(i);
            int tag = TagEditRules.parseTag(e.tag());
            if (tag == -1) {
                problems.add(new Problem(i, String.valueOf(e.tag()), "badTag"));
                continue;
            }
            String tagText = TagEditRules.format(tag);
            if (!seen.add(tag)) {
                problems.add(new Problem(i, tagText, "duplicate"));
                continue;
            }
            VR vr = TagEditRules.dictionaryVr(tag);
            if (vr == null) {
                vr = parseVr(e.vr());
            }
            String lock = TagEditRules.lockReason(tag, vr);
            if (lock != null) {
                problems.add(new Problem(i, tagText, lock));
                continue;
            }
            boolean remove = "remove".equals(e.op());
            if (!remove && !"set".equals(e.op())) {
                problems.add(new Problem(i, tagText, "badOp"));
                continue;
            }
            String value = e.value() == null ? "" : e.value();
            if (!remove) {
                String err = TagEditRules.valueError(vr, value);
                if (err != null) {
                    problems.add(new Problem(i, tagText, err));
                    continue;
                }
            }
            out.add(new CheckedEdit(tag, vr, remove, remove ? new String[0] : values(vr, value)));
        }
        if (!problems.isEmpty()) {
            throw new InvalidEditException(problems);
        }
        return out;
    }

    private static VR parseVr(String s) {
        if (s == null || s.isBlank()) {
            return null;
        }
        try {
            return VR.valueOf(s.trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static String[] values(VR vr, String value) {
        if (value.isEmpty()) {
            return new String[0];
        }
        if (vr == VR.LT || vr == VR.ST || vr == VR.UT || vr == VR.UR) {
            return new String[]{value};
        }
        return value.split("\\\\", -1);
    }

    private List<DicomInstance> rows(Scope s) {
        if (s == null || s.level() == null || s.studyUid() == null || s.studyUid().isBlank()) {
            throw new InvalidEditException(List.of(new Problem(-1, "", "badScope")));
        }
        List<DicomInstance> rows = switch (s.level()) {
            case "study" -> repo.findByStudyInstanceUid(s.studyUid());
            case "series" -> s.seriesUid() == null ? List.of() : repo.findBySeries(s.studyUid(), s.seriesUid());
            case "instance" -> s.sopUid() == null ? List.of()
                    : repo.findById(s.sopUid()).filter(r -> s.studyUid().equals(r.getStudyInstanceUid())).map(List::of)
                    .orElse(List.of());
            default -> throw new InvalidEditException(List.of(new Problem(-1, "", "badScope")));
        };
        if (rows.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "no-instances");
        }
        return rows;
    }

    // ── 確認（書かない） ──

    @Transactional(readOnly = true)
    public Preview preview(Scope scope, List<Edit> edits) {
        List<CheckedEdit> checked = check(edits);
        List<DicomInstance> rows = rows(scope);
        int[] differing = new int[checked.size()];
        int unreadable = 0;
        for (DicomInstance r : rows) {
            Attributes ds = readHeader(layout.resolveForRead(r));
            if (ds == null) {
                unreadable++;
                continue;
            }
            for (int i = 0; i < checked.size(); i++) {
                String before = edits.get(i).before() == null ? "" : edits.get(i).before();
                if (!before.equals(current(ds, checked.get(i).tag()))) {
                    differing[i]++;
                }
            }
        }
        List<PreviewItem> items = new ArrayList<>();
        for (int i = 0; i < checked.size(); i++) {
            items.add(new PreviewItem(TagEditRules.format(checked.get(i).tag()), differing[i]));
        }
        return new Preview(rows.size(), unreadable, items);
    }

    /** タグビューア（{@code TagDumpService}）と同じ表し方の今の値: 複数値は {@code \} でつなぐ。無ければ空。 */
    private static String current(Attributes ds, int tag) {
        String[] v = ds.getStrings(tag);
        return v == null ? "" : String.join("\\", v);
    }

    private static Attributes readHeader(Path f) {
        if (f == null || !Files.isRegularFile(f)) {
            return null;
        }
        try (DicomInputStream in = new DicomInputStream(f.toFile())) {
            in.readFileMetaInformation();
            return in.readDataset(-1, Tag.PixelData);
        } catch (IOException e) {
            return null;
        }
    }

    // ── 保存 ──

    @Transactional
    public Result apply(Scope scope, List<Edit> edits) {
        List<CheckedEdit> checked = check(edits);
        List<DicomInstance> rows = rows(scope);
        EnumSet<IndexedTag> cols = EnumSet.noneOf(IndexedTag.class);
        for (CheckedEdit c : checked) {
            IndexedTag.of(c.tag()).ifPresent(cols::add);
        }
        layout.prefetch(rows, () -> false); // 手元に無いものを先に取り寄せる（失敗は例外＝何も変えずに中止）
        List<DicomFileEdit.Target> targets = new ArrayList<>();
        for (DicomInstance r : rows) {
            Path file = layout.resolveForWrite(r);
            if (file != null && Files.isRegularFile(file)) {
                targets.add(new DicomFileEdit.Target(r.getSopInstanceUid(), file));
            } else {
                // 索引にあって実体が無い画像は書き換えられない。一部だけ変わるのを避けるため、編集全体を断る
                throw new ResponseStatusException(HttpStatus.CONFLICT, "tag-edit-failed: missing sop=" + r.getSopInstanceUid());
            }
        }
        checkPrivateCreators(checked, targets);
        Date now = new Date();
        DicomFileEdit edit;
        try {
            edit = DicomFileEdit.prepare(targets, (src, dst) -> rewrite(src, dst, checked, now),
                    layout.root().resolve(".edit-journal"), fileRetry, ops, DicomFileEdit.Kind.tags(cols));
            edit.swap();
        } catch (DicomFileEdit.EditFailedException e) {
            log.warn("タグの編集を中止（ファイル・索引は編集前のまま）: {}", e.getMessage());
            throw new ResponseStatusException(HttpStatus.CONFLICT, e.getMessage(), e);
        }
        edit.files().forEach(layout::notifyChanged);
        try {
            if (!cols.isEmpty()) {
                for (DicomInstance r : rows) {
                    for (CheckedEdit c : checked) {
                        IndexedTag.of(c.tag()).ifPresent(t -> t.toRow(r, applied(c)));
                    }
                    repo.save(r);
                }
            }
        } catch (RuntimeException e) {
            edit.rollback();
            throw e;
        }
        DbAdminService.settleWithTransaction(edit);
        log.info("タグを編集: 範囲={} {} 件, タグ={}", scope.level(), rows.size(),
                checked.stream().map(c -> TagEditRules.format(c.tag()) + (c.remove() ? "(削除)" : "")).toList());
        return new Result(targets.size(), cols.stream().map(Enum::name).toList());
    }

    /** 編集した値だけを持つ Attributes（索引の列を作る）。 */
    private static Attributes applied(CheckedEdit c) {
        Attributes a = new Attributes();
        if (!c.remove() && c.values().length > 0) {
            a.setString(c.tag(), c.vr(), c.values());
        }
        return a;
    }

    /** プライベートタグは、その番号を予約する Private Creator（gggg,00xx）が全ファイルに無いと足せない。 */
    private static void checkPrivateCreators(List<CheckedEdit> checked, List<DicomFileEdit.Target> targets) {
        List<CheckedEdit> priv = checked.stream().filter(c -> !c.remove() && ((c.tag() >>> 16) & 1) == 1).toList();
        if (priv.isEmpty()) {
            return;
        }
        for (DicomFileEdit.Target t : targets) {
            Attributes ds = readHeader(t.file());
            for (CheckedEdit c : priv) {
                int block = (c.tag() >>> 8) & 0xFF;
                int creator = (c.tag() & 0xFFFF0000) | block;
                if (ds == null || block < 0x10 || !ds.containsValue(creator)) {
                    throw new InvalidEditException(List.of(new Problem(checked.indexOf(c), TagEditRules.format(c.tag()),
                            "privateCreatorMissing")));
                }
            }
        }
    }

    /** {@code source} を読み、編集を当てて {@code target} へ書く（元は変えない）。値が同じなら記録も足さない。 */
    static void rewrite(Path source, Path target, List<CheckedEdit> edits, Date now) throws IOException {
        Attributes fmi;
        Attributes ds;
        try (DicomInputStream in = new DicomInputStream(source.toFile())) {
            in.setIncludeBulkData(IncludeBulkData.URI); // 画素はヒープに載せず、書くときに元ファイルからコピーする
            fmi = in.readFileMetaInformation();
            ds = in.readDataset();
        }
        Attributes original = new Attributes();
        for (CheckedEdit c : edits) {
            boolean present = ds.contains(c.tag());
            if (c.remove()) {
                if (present) {
                    original.addSelected(ds, c.tag());
                    ds.remove(c.tag());
                }
                continue;
            }
            String[] now0 = ds.getStrings(c.tag());
            if (present && Objects.equals(String.join("\\", now0 == null ? new String[0] : now0),
                    String.join("\\", c.values()))) {
                continue;
            }
            if (present) {
                original.addSelected(ds, c.tag());
            } else {
                original.setNull(c.tag(), c.vr());
            }
            if (c.values().length == 0) {
                ds.setNull(c.tag(), c.vr());
            } else {
                ds.setString(c.tag(), c.vr(), c.values());
            }
        }
        if (!original.isEmpty()) {
            Sequence oas = ds.getSequence(Tag.OriginalAttributesSequence);
            if (oas == null) {
                oas = ds.newSequence(Tag.OriginalAttributesSequence, 1);
            }
            Attributes item = new Attributes();
            item.setNull(Tag.SourceOfPreviousValues, VR.LO);
            item.setDate(Tag.AttributeModificationDateTime, VR.DT, now);
            item.setString(Tag.ModifyingSystem, VR.LO, MODIFYING_SYSTEM);
            item.setString(Tag.ReasonForTheAttributeModification, VR.CS, "CORRECT");
            item.newSequence(Tag.ModifiedAttributesSequence, 1).add(original);
            oas.add(item);
        }
        try (DicomOutputStream out = new DicomOutputStream(target.toFile())) {
            out.writeDataset(fmi, ds);
        }
    }
}

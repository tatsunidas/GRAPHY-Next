/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.store;

import com.vis.graphynext.dicom.DicomProperties;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 保管庫のルートと、索引 {@link DicomInstance#getUri()} ⇔ 実ファイルの対応を 1 か所に集める。
 *
 * <p>索引の値は 2 形式が混在する:
 * <ul>
 *   <li><b>相対</b>（現行）: ルートからの {@code <studyUid>/<seriesUid>/<sopUid>.dcm}（区切りは常に {@code /}）。
 *       保管フォルダごと別の場所へ複製しても、そのまま開ける。</li>
 *   <li><b>{@code file:} 絶対 URI</b>（旧来）: 書き換えずに読む。複製元を指したままの場合があるので、
 *       ルート外を指す値は規約パス（ルート/study/series/sop.dcm）で解決する。</li>
 * </ul>
 *
 * <p>🚨 書き込み系（削除・患者編集・シリーズ統合/分割）は {@link #resolveForWrite} を使う。
 * ルート外のファイルには決して作用させない——複製元の保管庫を書き換えてしまうため。
 */
@Component
public class StorageLayout {

    private final Path root;

    @Autowired
    public StorageLayout(DicomProperties props) {
        this(Path.of(props.getStorageDir()));
    }

    public StorageLayout(Path root) {
        this.root = root.toAbsolutePath().normalize();
    }

    public Path root() {
        return root;
    }

    private org.springframework.context.ApplicationEventPublisher events;
    private volatile StorageBackend backend = StorageBackend.NONE;

    /** モード A の取り寄せ口を登録する（{@code GdriveSyncService} が自分を登録する）。null なら何もしない実装に戻す。 */
    public void setBackend(StorageBackend backend) {
        this.backend = backend == null ? StorageBackend.NONE : backend;
    }

    /** モード A（Drive 正本・手元はキャッシュ）か。 */
    public boolean cacheMode() {
        return backend.cacheMode();
    }

    @Autowired(required = false)
    void setEvents(org.springframework.context.ApplicationEventPublisher events) {
        this.events = events;
    }

    /**
     * 保管庫のファイルを消した・書き換えた（しようとした）あとに呼ぶ。Drive 同期へ、利用者の操作であることを伝える。
     * モード A では手元に無いこと自体は削除を意味しないので、削除はこの通知が Drive 側へ伝わる唯一の経路になる。
     */
    public void notifyChanged(Path file) {
        if (events == null || file == null) {
            return;
        }
        try {
            events.publishEvent(new com.vis.graphynext.gdrive.StorageChanged(toStored(file)));
        } catch (IllegalArgumentException ignore) {
            // 保管庫の外のファイルは同期の対象ではない
        }
    }

    /** 規約パス {@code <root>/<studyUid>/<seriesUid>/<sopUid>.dcm}。UID が区切りや {@code ..} を含めば拒否する。 */
    public Path instancePath(String studyUid, String seriesUid, String sopUid) {
        return root.resolve(segment(studyUid)).resolve(segment(seriesUid)).resolve(segment(sopUid) + ".dcm");
    }

    /** ルート配下のファイルを、索引に保存する相対値（{@code /} 区切り）にする。 */
    public String toStored(Path file) {
        Path abs = file.toAbsolutePath().normalize();
        if (!abs.startsWith(root)) {
            throw new IllegalArgumentException("保管庫の外のファイルは索引に登録できません: " + abs);
        }
        StringBuilder sb = new StringBuilder();
        for (Path p : root.relativize(abs)) {
            if (sb.length() > 0) {
                sb.append('/');
            }
            sb.append(p);
        }
        return sb.toString();
    }

    /**
     * 読み取り用。実在するファイルを返す（無ければ null）。
     * 順序: 索引の値が指すルート配下のファイル → 規約パス → ルート外の旧来パス（読み取りのみ）。
     */
    public Path resolveForRead(DicomInstance inst) {
        Path local = resolveLocal(inst);
        if (!backend.cacheMode()) {
            return local;
        }
        if (local != null) {
            if (local.startsWith(root)) {
                backend.touch(toStored(local));
            }
            return local;
        }
        // 手元に無い。Drive が正本のファイルなら取り寄せる（失敗は null にせず例外）
        Path target = resolveForWrite(inst);
        return target == null ? null : backend.ensureLocal(toStored(target));
    }

    /**
     * {@code insts} のうち手元に無いものを、先にまとめて取り寄せる（モード A）。一括で解決する呼び出し側
     * （送信・エクスポート・線量・RT/SEG）が、1 件ずつ遅い取得を直列に待たないため。失敗は例外。
     */
    public void prefetch(java.util.Collection<DicomInstance> insts, java.util.function.BooleanSupplier cancelled) {
        if (!backend.cacheMode()) {
            return;
        }
        java.util.List<String> rels = new java.util.ArrayList<>();
        for (DicomInstance inst : insts) {
            if (resolveLocal(inst) == null) {
                Path target = resolveForWrite(inst);
                if (target != null) {
                    rels.add(toStored(target));
                }
            }
        }
        if (!rels.isEmpty()) {
            backend.prefetch(rels, cancelled);
        }
    }

    /** このインスタンスのファイルが手元にあるか（取り寄せはしない）。 */
    public boolean isLocal(DicomInstance inst) {
        return resolveLocal(inst) != null;
    }

    /** 手元にある実在のファイル（無ければ null）。取り寄せはしない。一覧の表示のように、見ただけで Drive から落としたくない読み取り用。 */
    public Path localPath(DicomInstance inst) {
        return resolveLocal(inst);
    }

    /** 手元にある実在のファイル（無ければ null）。取り寄せはしない。 */
    private Path resolveLocal(DicomInstance inst) {
        String uri = inst.getUri();
        if (uri != null && !isLegacy(uri)) {
            Path p = fromRelative(uri);
            return p != null && Files.exists(p) ? p : null;
        }
        Path legacy = uri == null ? null : fromLegacy(uri);
        if (legacy != null && legacy.startsWith(root) && Files.exists(legacy)) {
            return legacy;
        }
        Path conv = conventional(inst);
        if (conv != null && Files.exists(conv)) {
            return conv;
        }
        return legacy != null && Files.exists(legacy) ? legacy : null;
    }

    /**
     * 書き込み用。必ずルート配下のパスを返す（実在は問わない）。ルート配下に解決できなければ null。
     * 旧来の値がルート外を指す場合は規約パスに読み替える。
     */
    public Path resolveForWrite(DicomInstance inst) {
        String uri = inst.getUri();
        if (uri != null && !isLegacy(uri)) {
            return fromRelative(uri);
        }
        Path legacy = uri == null ? null : fromLegacy(uri);
        if (legacy != null && legacy.startsWith(root)) {
            return legacy;
        }
        return conventional(inst);
    }

    /**
     * ファイルを消したあとに呼ぶ。親（シリーズ）とその親（検査）が空なら消す。
     * ルートそのものと、ルートの外には触れない。中身が残っていれば何もしない。
     */
    public void pruneEmptyDirs(Path deletedFile) {
        Path dir = deletedFile.toAbsolutePath().normalize().getParent();
        for (int i = 0; i < 2 && dir != null && dir.startsWith(root) && !dir.equals(root); i++) {
            try (java.util.stream.Stream<Path> s = Files.list(dir)) {
                if (s.findAny().isPresent()) {
                    return;
                }
            } catch (java.io.IOException e) {
                return;
            }
            try {
                Files.deleteIfExists(dir);
            } catch (java.io.IOException e) {
                return; // 別の処理が同時に書き込んだなど。空フォルダが残るだけなので続けない
            }
            dir = dir.getParent();
        }
    }

    private static boolean isLegacy(String uri) {
        return uri.startsWith("file:");
    }

    private static Path fromLegacy(String uri) {
        try {
            return Path.of(URI.create(uri)).toAbsolutePath().normalize();
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** 相対値をルートに結ぶ。絶対パス・ドライブ指定・{@code ..} を含むものは null（ルート外へ出さない）。 */
    private Path fromRelative(String rel) {
        if (rel.isEmpty() || rel.startsWith("/") || rel.indexOf('\\') >= 0 || rel.indexOf(':') >= 0) {
            return null;
        }
        Path p = root;
        for (String s : rel.split("/")) {
            if (s.isEmpty() || s.equals(".") || s.equals("..")) {
                return null;
            }
            p = p.resolve(s);
        }
        return p;
    }

    private Path conventional(DicomInstance inst) {
        try {
            return instancePath(inst.getStudyInstanceUid(), inst.getSeriesInstanceUid(), inst.getSopInstanceUid());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static String segment(String uid) {
        if (uid == null || uid.isEmpty() || uid.equals(".") || uid.equals("..")
                || uid.indexOf('/') >= 0 || uid.indexOf('\\') >= 0 || uid.indexOf(':') >= 0) {
            throw new IllegalArgumentException("保管パスに使えない UID: " + uid);
        }
        return uid;
    }
}

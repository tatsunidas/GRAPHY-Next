/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import com.vis.graphynext.compute.ComputeDatasetService;
import com.vis.graphynext.plugin.PluginJobService;
import com.vis.graphynext.plugin.PluginRegistry;
import com.vis.graphynext.plugin.PluginWorkFiles;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;

/**
 * H78・H79（仮）: プラグインの JAR と本体の間で NIfTI を受け渡す口（fw/nifti-import.md §11）。研究用の画像形式
 * （ECAT7・Interfile・AFNI・MINC・BIDS など）の読み書きはプラグインに置き、本体は NIfTI を「作る」「取り込む」だけを開ける。
 *
 * <ul>
 *   <li>{@code POST /api/plugins/{id}/nifti/export} … 1 シリーズを NIfTI にして、そのプラグインの作業フォルダへ置き、パスを返す
 *       （匿名化の出力から作る。断る形の理由コードは本体の書き出しと同じ）</li>
 *   <li>{@code POST /api/plugins/{id}/nifti/release} … 渡したファイルを消す（そのプラグインのフォルダの下だけ）</li>
 *   <li>{@code POST /api/plugins/{id}/nifti/probe} … プラグインが作った NIfTI の下読み（確認画面に出す）</li>
 *   <li>{@code POST /api/plugins/{id}/nifti/import} … 取り込む（本体の確認画面は画面側が必ず出す）</li>
 * </ul>
 *
 * <p>受け取るパスは {@code <java.io.tmpdir>/graphy-plugin-nifti/<プラグイン ID>/} の下の実在する通常のファイルだけ
 * （{@link PluginWorkFiles}。任意のパスを受ける {@code /api/nifti/import} をプラグインに使わせない）。
 */
@RestController
@Profile("standalone") // サーバー上のパスを扱うので web では出さない（fw/security.md「サーバー上のパス」）
public class PluginNiftiController {

    private static final Logger log = LoggerFactory.getLogger(PluginNiftiController.class);

    /** プラグインと本体が NIfTI を受け渡す一時フォルダの名前（tmp の下）。プラグインの JAR もこの名前を使う。 */
    public static final String WORK_DIR = "graphy-plugin-nifti";
    /** 書き出して渡したまま消されなかったファイルを掃除する期限（{@code ComputeDatasetService} の一時データと同じ 2 時間）。 */
    static final Duration TTL = Duration.ofHours(2);

    private final PluginRegistry registry;
    private final PluginJobService jobs;
    private final NiftiImportService importer;
    private final ComputeDatasetService datasets;
    private final Path tmpRoot;

    @Autowired
    public PluginNiftiController(PluginRegistry registry, PluginJobService jobs, NiftiImportService importer,
                                 ComputeDatasetService datasets) {
        this(registry, jobs, importer, datasets, Path.of(System.getProperty("java.io.tmpdir")));
    }

    PluginNiftiController(PluginRegistry registry, PluginJobService jobs, NiftiImportService importer,
                          ComputeDatasetService datasets, Path tmpRoot) {
        this.registry = registry;
        this.jobs = jobs;
        this.importer = importer;
        this.datasets = datasets;
        this.tmpRoot = tmpRoot;
    }

    public record ExportRequest(String studyUid, String seriesUid) {
    }

    public record PathRequest(String path) {
    }


    // ── H78: 書き出し ───────────────────────────────────────────────

    @PostMapping("/api/plugins/{id}/nifti/export")
    public ResponseEntity<Object> export(@PathVariable String id, @RequestBody ExportRequest req) {
        ResponseEntity<Object> gate = gate(id);
        if (gate != null) {
            return gate;
        }
        if (req == null || blank(req.studyUid()) || blank(req.seriesUid())) {
            return ResponseEntity.badRequest().body(Map.of("ok", false, "error", "bad-request"));
        }
        sweep(id);
        ComputeDatasetService.Dataset d;
        try {
            // localDestination=true: この PC の外へは出ない扱い（本体の書き出し・NIfTI の画面と同じ規則）
            d = datasets.create(req.studyUid(), req.seriesUid(), ComputeDatasetService.Format.NIFTI, true);
        } catch (ComputeDatasetService.DatasetRefused e) {
            return ResponseEntity.unprocessableEntity().body(Map.of("ok", false, "error", e.reason()));
        }
        try {
            Path dir = tmpRoot.resolve(WORK_DIR).resolve(id).resolve(UUID.randomUUID().toString());
            Files.createDirectories(dir);
            Path out = dir.resolve("volume.nii.gz");
            Files.move(d.file(), out, StandardCopyOption.REPLACE_EXISTING);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("ok", true);
            body.put("path", out.toAbsolutePath().toString());
            body.put("bytes", Files.size(out));
            body.put("slices", d.instances());
            ComputeDatasetService.NiftiInfo info = d.niftiInfo();
            body.put("frames", info == null ? 1 : info.phases());
            // 時相の間隔（秒）。決まらないとき（不明・不均一）と 3D は null（推測の値は返さない）
            body.put("timeStepSec", info != null && info.dtSeconds() > 0 ? info.dtSeconds() : null);
            log.info("[nifti] plugin export plugin={} series={} bytes={}", id, req.seriesUid(), body.get("bytes"));
            return ResponseEntity.ok(body);
        } catch (IOException e) {
            return ResponseEntity.internalServerError().body(Map.of("ok", false, "error", "write-failed"));
        } finally {
            datasets.discard(d.handle()); // 一時データ（匿名化の出力の置き場）は渡したら要らない
        }
    }

    @PostMapping("/api/plugins/{id}/nifti/release")
    public ResponseEntity<Object> release(@PathVariable String id, @RequestBody PathRequest req) {
        ResponseEntity<Object> gate = gate(id);
        if (gate != null) {
            return gate;
        }
        try {
            Path file = allowedPath(id, req == null ? null : req.path());
            Files.deleteIfExists(file);
            deleteEmptyParent(file, id);
            return ResponseEntity.ok(Map.of("ok", true));
        } catch (IOException | IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("ok", false, "error", String.valueOf(e.getMessage())));
        }
    }

    // ── H79: 取り込み ───────────────────────────────────────────────

    @PostMapping("/api/plugins/{id}/nifti/probe")
    public ResponseEntity<Object> probe(@PathVariable String id, @RequestBody PathRequest req) {
        ResponseEntity<Object> gate = gate(id);
        if (gate != null) {
            return gate;
        }
        try {
            Path file = allowedPath(id, req == null ? null : req.path());
            return ResponseEntity.ok(NiftiImportController.probeOf(file));
        } catch (IOException | IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("ok", false, "error", String.valueOf(e.getMessage())));
        }
    }

    @PostMapping("/api/plugins/{id}/nifti/import")
    public ResponseEntity<Object> importNifti(@PathVariable String id, @RequestBody NiftiImportController.ImportRequest req) {
        ResponseEntity<Object> gate = gate(id);
        if (gate != null) {
            return gate;
        }
        Path file;
        Path sidecar = null;
        try {
            file = allowedPath(id, req == null ? null : req.path());
            if (req.metadataPath() != null && !req.metadataPath().isBlank()) {
                sidecar = allowedPath(id, req.metadataPath());
            }
        } catch (IOException | IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("ok", false, "error", String.valueOf(e.getMessage())));
        }
        final Path sidecarFile = sidecar;
        return ResponseEntity.ok(jobs.submitTask(id, ctx -> {
            try {
                Map<String, Object> meta = sidecarFile == null ? Map.of() : NiftiImportController.readMetadata(sidecarFile.toString());
                NiftiImportService.Result r = NiftiImportController.importFrom(importer, file, meta, req);
                if (r.error() != null) {
                    throw new IllegalStateException(r.error());
                }
                return r;
            } finally {
                // 本体が受け取ったら（失敗しても）、プラグインの一時ファイルは要らない。2 ファイル形式（.hdr/.img）の相方も消す
                Files.deleteIfExists(file);
                if (sidecarFile != null) {
                    Files.deleteIfExists(sidecarFile);
                }
                deletePairMate(file);
                deleteEmptyParent(file, id);
            }
        }));
    }

    // ── 共通 ───────────────────────────────────────────────────────

    /** 登録外のプラグインは 404、standalone でない（ローカルのファイルを扱えない）は 501。通れば null。 */
    private ResponseEntity<Object> gate(String id) {
        if (registry.manifests().stream().noneMatch(m -> id.equals(m.id()))) {
            return ResponseEntity.notFound().build();
        }
        if (!registry.localFilesAllowed()) {
            return ResponseEntity.status(501).body(Map.of("ok", false, "error", "desktop-only"));
        }
        return null;
    }

    Path allowedPath(String pluginId, String path) throws IOException {
        return PluginWorkFiles.allowedPath(tmpRoot, WORK_DIR, pluginId, path);
    }

    /** そのプラグインのフォルダで、{@link #TTL} より古いものを消す（渡したまま消されなかった分）。 */
    void sweep(String pluginId) {
        Path dir = tmpRoot.resolve(WORK_DIR).resolve(pluginId);
        if (!Files.isDirectory(dir)) {
            return;
        }
        Instant limit = Instant.now().minus(TTL);
        try (Stream<Path> children = Files.list(dir)) {
            children.forEach(c -> {
                try {
                    if (!Files.isSymbolicLink(c) && Files.getLastModifiedTime(c).toInstant().isBefore(limit)) {
                        deleteTree(c);
                    }
                } catch (IOException e) {
                    log.warn("[nifti] 古い一時ファイルを消せません: {}", c.getFileName());
                }
            });
        } catch (IOException e) {
            log.warn("[nifti] プラグインの一時フォルダを読めません: {}", e.getMessage());
        }
    }

    private static void deleteTree(Path p) throws IOException {
        if (Files.isDirectory(p) && !Files.isSymbolicLink(p)) {
            try (Stream<Path> s = Files.list(p)) {
                for (Path c : (Iterable<Path>) s::iterator) {
                    deleteTree(c);
                }
            }
        }
        Files.deleteIfExists(p);
    }

    /** ファイルを消したあと、それだけが入っていたジョブ用のサブフォルダが空なら消す（プラグインのフォルダ自体は残す）。 */
    private void deleteEmptyParent(Path file, String pluginId) {
        Path parent = file.getParent();
        Path pluginDir = tmpRoot.resolve(WORK_DIR).resolve(pluginId);
        try {
            if (parent != null && Files.isDirectory(pluginDir) && !parent.equals(pluginDir.toRealPath())
                    && parent.startsWith(pluginDir.toRealPath())) {
                try (Stream<Path> s = Files.list(parent)) {
                    if (s.findAny().isEmpty()) {
                        Files.deleteIfExists(parent);
                    }
                }
            }
        } catch (IOException e) {
            // 空フォルダが残るだけ。TTL の掃除が消す
        }
    }

    /** {@code .hdr} を渡されたとき {@code .img}（逆も）の相方を消す。 */
    private static void deletePairMate(Path file) {
        try {
            if (NiftiPair.isPairPath(file)) {
                NiftiPair pair = NiftiPair.resolve(file);
                Files.deleteIfExists(pair.data());
            }
        } catch (IOException | RuntimeException e) {
            // 相方が無い・読めないときは何もしない
        }
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }
}

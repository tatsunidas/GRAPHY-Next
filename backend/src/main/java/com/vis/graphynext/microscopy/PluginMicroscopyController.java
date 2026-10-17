/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.microscopy;

import com.vis.graphynext.plugin.PluginJobService;
import com.vis.graphynext.plugin.PluginRegistry;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Profile;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.Map;

/**
 * H68: プラグインが自分のジョブで書いた画素（Raw）を CFM として取り込む（fw/microscopy-cfm.md）。
 *
 * <p>受け付けるのは {@code <java.io.tmpdir>/graphy-plugin-microscopy/<プラグイン ID>/} の下の、実在する通常のファイルだけ
 * （シンボリックリンク・ほかのプラグインのフォルダ・その外は断る）。任意のパスを受ける {@code /api/microscopy/import} を
 * プラグインに使わせないため。取り込みは本体のジョブ（{@link PluginJobService#submitTask}）で走らせ、終わったらその一時ファイルを消す。
 * 確認画面は画面側（H68 の実装）が必ず出す。
 */
@RestController
@Profile("standalone") // サーバー上のパスを受けるので web では出さない（fw/security.md「サーバー上のパス」）
public class PluginMicroscopyController {

    /** プラグインが画素を書く一時フォルダの名前（tmp の下）。プラグインの JAR もこの名前を使う。 */
    public static final String WORK_DIR = "graphy-plugin-microscopy";

    private final PluginRegistry registry;
    private final PluginJobService jobs;
    private final MicroscopyImportService service;
    private final Path tmpRoot;

    @Autowired
    public PluginMicroscopyController(PluginRegistry registry, PluginJobService jobs, MicroscopyImportService service) {
        this(registry, jobs, service, Path.of(System.getProperty("java.io.tmpdir")));
    }

    PluginMicroscopyController(PluginRegistry registry, PluginJobService jobs, MicroscopyImportService service, Path tmpRoot) {
        this.registry = registry;
        this.jobs = jobs;
        this.service = service;
        this.tmpRoot = tmpRoot;
    }

    @PostMapping("/api/plugins/{id}/microscopy/import")
    public ResponseEntity<Object> importChannel(@PathVariable String id, @RequestBody MicroscopyImportService.ImportRequest req) {
        if (registry.manifests().stream().noneMatch(m -> id.equals(m.id()))) {
            return ResponseEntity.notFound().build();
        }
        if (!registry.localFilesAllowed()) {
            return ResponseEntity.status(501).body(Map.of("error", "desktop-only"));
        }
        Path file;
        try {
            file = allowedPath(id, req == null ? null : req.path());
        } catch (IOException | IllegalArgumentException e) {
            return ResponseEntity.badRequest().body(Map.of("error", String.valueOf(e.getMessage())));
        }
        MicroscopyImportService.ImportRequest fixed = withPath(req, file.toString());
        return ResponseEntity.ok(jobs.submitTask(id, ctx -> {
            try {
                return service.importChannel(fixed, ctx.progress());
            } finally {
                Files.deleteIfExists(file); // 本体が受け取ったら、プラグインの一時ファイルは要らない
            }
        }));
    }

    /** そのプラグインの作業フォルダの下の、実在する通常のファイル（リンクを辿らない）。それ以外は理由つきで断る。 */
    Path allowedPath(String pluginId, String path) throws IOException {
        if (path == null || path.isBlank()) {
            throw new IllegalArgumentException("パスがありません");
        }
        if (pluginId.contains("/") || pluginId.contains("\\") || pluginId.contains("..")) {
            throw new IllegalArgumentException("プラグイン ID が正しくありません");
        }
        Path p = Path.of(path);
        if (!p.isAbsolute() || Files.isSymbolicLink(p) || !Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS)) {
            throw new IllegalArgumentException("一時フォルダのファイルではありません: " + p.getFileName());
        }
        Path real = p.toRealPath(LinkOption.NOFOLLOW_LINKS);
        Path dir = tmpRoot.resolve(WORK_DIR).resolve(pluginId);
        Path realDir = Files.isDirectory(dir) ? dir.toRealPath() : dir.toAbsolutePath().normalize();
        if (!real.startsWith(realDir)) {
            throw new IllegalArgumentException("このプラグインの一時フォルダのファイルだけを取り込めます");
        }
        return real;
    }

    private static MicroscopyImportService.ImportRequest withPath(MicroscopyImportService.ImportRequest r, String path) {
        return new MicroscopyImportService.ImportRequest(path, r.spec(), r.channelName(), r.wavelengthNm(), r.confocalMode(),
                r.sourceFormat(), r.sourceName(), r.anatomy(), r.patientId(), r.patientName(), r.patientBirthDate(),
                r.patientSex(), r.studyInstanceUid(), r.studyDescription(), r.seriesDescription(), r.seriesNumber(),
                r.frameOfReferenceUid(), r.specimenUid());
    }
}

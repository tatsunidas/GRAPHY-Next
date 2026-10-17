/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.microscopy;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.BiConsumer;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;

import com.vis.graphynext.nifti.RawSpec;
import com.vis.graphynext.plugin.PluginJobService;
import com.vis.graphynext.plugin.PluginManifest;
import com.vis.graphynext.plugin.PluginRegistry;

/** H68 の入口: そのプラグインの一時フォルダのファイルだけを、本体のジョブで取り込み、取り込んだら消す。 */
class PluginMicroscopyControllerTest {

    @TempDir
    Path tmp;

    private static PluginRegistry registry(boolean local) {
        return new PluginRegistry() {
            @Override
            public List<PluginManifest> manifests() {
                return List.of(new PluginManifest("micro", "Micro", "0.1.0", null, null, List.of(), null),
                        new PluginManifest("other", "Other", "0.1.0", null, null, List.of(), null));
            }

            @Override
            public Optional<byte[]> uiBundle(String id) {
                return Optional.empty();
            }

            @Override
            public Object run(String id, Map<String, Object> payload) {
                return null;
            }

            @Override
            public void checkRunnable(String id) {
            }

            @Override
            public boolean localFilesAllowed() {
                return local;
            }
        };
    }

    /** 取り込んだことだけを覚える取り込み役。 */
    private static final class Recording extends MicroscopyImportService {
        String importedPath;
        boolean existedWhenImported;

        Recording() {
            super(null, null);
        }

        @Override
        public ImportResult importChannel(ImportRequest req, BiConsumer<Double, String> progress) {
            importedPath = req.path();
            existedWhenImported = Files.exists(Path.of(req.path()));
            return new ImportResult("1.2", "1.3", "1.4", "1.5", 3);
        }
    }

    private static MicroscopyImportService.ImportRequest req(Path p) {
        return new MicroscopyImportService.ImportRequest(p.toString(),
                new RawSpec(2, 2, 3, 1, "uint8", "little", 0, new double[] { 1, 1, 1 }, "axial", null),
                "Ch1", null, null, "Zeiss LSM", "a.lsm", null, "P", null, null, null, null, null, null, 1, null, null);
    }

    private Path work(String plugin, String name) throws IOException {
        Path d = tmp.resolve(PluginMicroscopyController.WORK_DIR).resolve(plugin).resolve("job1");
        Files.createDirectories(d);
        Path f = d.resolve(name);
        Files.write(f, new byte[12]);
        return f;
    }

    private static PluginJobService.Status await(PluginJobService jobs, String id) throws InterruptedException {
        for (int i = 0; i < 200; i++) {
            PluginJobService.Status st = jobs.status(id).orElseThrow();
            if (st.ended()) {
                return st;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("終わらない");
    }

    @Test
    void そのプラグインの一時フォルダのファイルを取り込み_終わったら消す() throws Exception {
        PluginJobService jobs = new PluginJobService(registry(true));
        Recording svc = new Recording();
        PluginMicroscopyController c = new PluginMicroscopyController(registry(true), jobs, svc, tmp);
        Path f = work("micro", "ch0.raw");
        ResponseEntity<Object> r = c.importChannel("micro", req(f));
        assertThat(r.getStatusCode().value()).isEqualTo(200);
        PluginJobService.Status st = await(jobs, ((PluginJobService.Status) r.getBody()).jobId());
        assertThat(st.state()).isEqualTo(PluginJobService.State.DONE);
        assertThat(svc.existedWhenImported).isTrue();
        assertThat(f).doesNotExist();
    }

    @Test
    void 一時フォルダの外_ほかのプラグインのフォルダ_リンク_ドットドットは断る() throws Exception {
        PluginMicroscopyController c = new PluginMicroscopyController(registry(true), new PluginJobService(registry(true)),
                new Recording(), tmp);
        Path outside = tmp.resolve("elsewhere.raw");
        Files.write(outside, new byte[12]);
        assertThatThrownBy(() -> c.allowedPath("micro", outside.toString())).hasMessageContaining("一時フォルダ");
        Path others = work("other", "ch0.raw");
        assertThatThrownBy(() -> c.allowedPath("micro", others.toString())).hasMessageContaining("このプラグイン");
        Path link = work("micro", "real.raw").resolveSibling("link.raw");
        Files.createSymbolicLink(link, outside);
        assertThatThrownBy(() -> c.allowedPath("micro", link.toString())).hasMessageContaining("一時フォルダ");
        Path dotdot = tmp.resolve(PluginMicroscopyController.WORK_DIR).resolve("micro").resolve("..").resolve("other")
                .resolve("job1").resolve("ch0.raw");
        assertThatThrownBy(() -> c.allowedPath("micro", dotdot.toString())).hasMessageContaining("このプラグイン");
        assertThatThrownBy(() -> c.allowedPath("micro", "relative.raw")).isInstanceOf(IllegalArgumentException.class);
        // 正例
        assertThat(c.allowedPath("micro", work("micro", "ok.raw").toString())).exists();
        // 断ったときはジョブに入らず 400
        assertThat(c.importChannel("micro", req(outside)).getStatusCode().value()).isEqualTo(400);
    }

    @Test
    void 一時フォルダが別名のリンクでも受け付け_中のリンクで外へ出るのは断る() throws Exception {
        // macOS の /var/folders → /private/var/folders と同じ形: tmp の別名（リンク）を本体の tmp として渡す
        Path realTmp = tmp.resolve("real-tmp");
        Files.createDirectories(realTmp);
        Path aliasTmp = tmp.resolve("alias-tmp");
        Files.createSymbolicLink(aliasTmp, realTmp);
        PluginMicroscopyController c = new PluginMicroscopyController(registry(true), new PluginJobService(registry(true)),
                new Recording(), aliasTmp);
        Path d = aliasTmp.resolve(PluginMicroscopyController.WORK_DIR).resolve("micro").resolve("job1");
        Files.createDirectories(d);
        Path f = d.resolve("ch0.raw");
        Files.write(f, new byte[12]);
        assertThat(c.allowedPath("micro", f.toString())).exists();
        // プラグインのフォルダの中に、外を指すフォルダのリンクを置かれても断る
        Path outsideDir = tmp.resolve("outside-dir");
        Files.createDirectories(outsideDir);
        Files.write(outsideDir.resolve("x.raw"), new byte[12]);
        Path linkDir = aliasTmp.resolve(PluginMicroscopyController.WORK_DIR).resolve("micro").resolve("escape");
        Files.createSymbolicLink(linkDir, outsideDir);
        assertThatThrownBy(() -> c.allowedPath("micro", linkDir.resolve("x.raw").toString())).hasMessageContaining("このプラグイン");
    }

    @Test
    void 知らないプラグインは404_web_は501() throws Exception {
        Path f = work("micro", "ch0.raw");
        assertThat(new PluginMicroscopyController(registry(true), new PluginJobService(registry(true)), new Recording(), tmp)
                .importChannel("nobody", req(f)).getStatusCode().value()).isEqualTo(404);
        assertThat(new PluginMicroscopyController(registry(false), new PluginJobService(registry(false)), new Recording(), tmp)
                .importChannel("micro", req(f)).getStatusCode().value()).isEqualTo(501);
    }
}

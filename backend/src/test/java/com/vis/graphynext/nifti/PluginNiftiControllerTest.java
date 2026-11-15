/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.http.ResponseEntity;

import com.vis.graphynext.compute.ComputeDatasetService;
import com.vis.graphynext.plugin.PluginJobService;
import com.vis.graphynext.plugin.PluginManifest;
import com.vis.graphynext.plugin.PluginRegistry;

/**
 * H78・H79（仮）の入口。書き出しはプラグインの作業フォルダへ渡して一時データを捨て、取り込みはそのフォルダのファイルだけを受け、
 * 取り込んだら（失敗しても）消す。任意のパス（外・他プラグイン・リンク）は断る。
 * ⚠ Mockito はこの開発機の JDK 25 で動かないので使わない（取り込み役・データセット役は手書きの継承）。
 */
class PluginNiftiControllerTest {

    @TempDir
    Path tmp;

    private static PluginRegistry registry(boolean local) {
        return new PluginRegistry() {
            @Override
            public List<PluginManifest> manifests() {
                return List.of(new PluginManifest("nb", "Bridge", "0.1.0", null, null, List.of(), null),
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

    /** 取り込んだことだけを覚える取り込み役（失敗も作れる）。 */
    private static final class Recording extends NiftiImportService {
        Path importedPath;
        boolean existedWhenImported;
        Map<String, Object> metadata;
        NiftiToDicom.Options options;
        String failWith;
        int calls;

        Recording() {
            super(null);
        }

        @Override
        public Result importFile(Path nifti, Map<String, Object> metadata, NiftiToDicom.Options opts) {
            calls++;
            importedPath = nifti;
            existedWhenImported = Files.exists(nifti);
            this.metadata = metadata;
            this.options = opts;
            if (failWith != null) {
                return failure(failWith);
            }
            return new Result(1, 0, 3, 1, 1, 2, 2, "sform", false, "1.2", "1.3", 0, "float32", null, null);
        }
    }

    /** 作る結果を決められるデータセット役。捨てたハンドルを覚える。 */
    private final class Datasets extends ComputeDatasetService {
        String refuse;
        String discarded;
        int created;
        Path madeFile;
        NiftiInfo info = new NiftiInfo(1, 0);

        Datasets() {
            super(null, null, null);
        }

        @Override
        public Dataset create(String studyUid, String seriesUid, Format format, boolean localDestination) {
            created++;
            if (refuse != null) {
                throw new DatasetRefused(refuse, null);
            }
            try {
                Path dir = Files.createDirectories(tmp.resolve("graphy-compute-x" + created));
                madeFile = dir.resolve("dataset.nii.gz");
                Files.write(madeFile, new byte[]{1, 2, 3, 4, 5});
            } catch (IOException e) {
                throw new IllegalStateException(e);
            }
            return new Dataset("dsh_" + created, format, madeFile, 5, "x", 16, 0, studyUid, seriesUid, "CT", Instant.now(), true, info);
        }

        @Override
        public void discard(String handle) {
            discarded = handle;
        }
    }

    private PluginNiftiController controller(boolean local, Recording rec, Datasets ds) {
        return new PluginNiftiController(registry(local), new PluginJobService(registry(local)), rec, ds, tmp);
    }

    private Path work(String plugin, String name) throws IOException {
        Path d = tmp.resolve(PluginNiftiController.WORK_DIR).resolve(plugin).resolve("job1");
        Files.createDirectories(d);
        Path f = d.resolve(name);
        Files.write(f, new byte[16]);
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

    private static NiftiImportController.ImportRequest req(Path p, Path sidecar) {
        return new NiftiImportController.ImportRequest(p.toString(), sidecar == null ? null : sidecar.toString(), "MR",
                "P1", "Name^P", null, null, null, null, "series", 4, null, null);
    }

    // ── H78: 書き出し ───────────────────────────────────────────────

    @Test
    void 書き出しはそのプラグインの作業フォルダへ渡し_一時データを捨てる() throws Exception {
        Datasets ds = new Datasets();
        ds.info = new ComputeDatasetService.NiftiInfo(10, 5.0);
        PluginNiftiController c = controller(true, new Recording(), ds);
        ResponseEntity<Object> r = c.export("nb", new PluginNiftiController.ExportRequest("S", "T"));
        assertThat(r.getStatusCode().value()).isEqualTo(200);
        @SuppressWarnings("unchecked")
        Map<String, Object> body = (Map<String, Object>) r.getBody();
        Path out = Path.of((String) body.get("path"));
        assertThat(out).exists().hasFileName("volume.nii.gz");
        assertThat(out.toRealPath()).startsWith(tmp.resolve(PluginNiftiController.WORK_DIR).resolve("nb").toRealPath());
        assertThat(Files.readAllBytes(out)).containsExactly(1, 2, 3, 4, 5);
        assertThat(ds.madeFile).doesNotExist(); // 動かした（コピーではない）
        assertThat(ds.discarded).isEqualTo("dsh_1");
        assertThat(body).containsEntry("ok", true).containsEntry("bytes", 5L).containsEntry("slices", 16)
                .containsEntry("frames", 10).containsEntry("timeStepSec", 5.0);
        // 渡したパスは、そのプラグインの allowedPath を通る（H79 の取り込みへそのまま渡せる）
        assertThat(c.allowedPath("nb", out.toString())).exists();
    }

    @Test
    void 時間間隔が決まらない4Dと3Dは_間隔を推測せずnullで返す() throws Exception {
        Datasets ds = new Datasets();
        ds.info = new ComputeDatasetService.NiftiInfo(4, 0); // 0 = 均等と確かめられなかった・時刻が無い
        @SuppressWarnings("unchecked")
        Map<String, Object> four = (Map<String, Object>) controller(true, new Recording(), ds)
                .export("nb", new PluginNiftiController.ExportRequest("S", "T")).getBody();
        assertThat(four).containsEntry("frames", 4);
        assertThat(four.get("timeStepSec")).isNull();
        Datasets ds3 = new Datasets();
        ds3.info = null;
        @SuppressWarnings("unchecked")
        Map<String, Object> three = (Map<String, Object>) controller(true, new Recording(), ds3)
                .export("nb", new PluginNiftiController.ExportRequest("S", "T")).getBody();
        assertThat(three).containsEntry("frames", 1);
        assertThat(three.get("timeStepSec")).isNull();
    }

    @Test
    void 書き出しの負例_登録外は404_standaloneでなければ501_入力なしは400_断る形は理由つき422() throws Exception {
        Datasets ds = new Datasets();
        PluginNiftiController c = controller(true, new Recording(), ds);
        assertThat(c.export("nobody", new PluginNiftiController.ExportRequest("S", "T")).getStatusCode().value()).isEqualTo(404);
        assertThat(controller(false, new Recording(), ds).export("nb", new PluginNiftiController.ExportRequest("S", "T"))
                .getStatusCode().value()).isEqualTo(501);
        assertThat(c.export("nb", new PluginNiftiController.ExportRequest("", "T")).getStatusCode().value()).isEqualTo(400);
        assertThat(c.export("nb", null).getStatusCode().value()).isEqualTo(400);
        assertThat(ds.created).isZero(); // ここまでで何も作っていない
        ds.refuse = "volume-sheared";
        ResponseEntity<Object> r = c.export("nb", new PluginNiftiController.ExportRequest("S", "T"));
        assertThat(r.getStatusCode().value()).isEqualTo(422);
        assertThat(r.getBody()).isEqualTo(Map.of("ok", false, "error", "volume-sheared"));
        assertThat(tmp.resolve(PluginNiftiController.WORK_DIR).resolve("nb")).doesNotExist(); // 断ったらファイルを置かない
    }

    @Test
    void releaseは自分のフォルダのファイルだけ消し_空になったジョブのフォルダも消す() throws Exception {
        PluginNiftiController c = controller(true, new Recording(), new Datasets());
        Path mine = work("nb", "a.nii.gz");
        Path others = work("other", "b.nii.gz");
        Path outside = tmp.resolve("elsewhere.nii.gz");
        Files.write(outside, new byte[4]);
        assertThat(c.release("nb", new PluginNiftiController.PathRequest(others.toString())).getStatusCode().value()).isEqualTo(400);
        assertThat(c.release("nb", new PluginNiftiController.PathRequest(outside.toString())).getStatusCode().value()).isEqualTo(400);
        assertThat(others).exists();
        assertThat(outside).exists();
        assertThat(c.release("nb", new PluginNiftiController.PathRequest(mine.toString())).getStatusCode().value()).isEqualTo(200);
        assertThat(mine).doesNotExist();
        assertThat(mine.getParent()).doesNotExist();
        assertThat(tmp.resolve(PluginNiftiController.WORK_DIR).resolve("nb")).exists(); // プラグインのフォルダは残す
    }

    @Test
    void 渡したまま消されなかった古いものは次の書き出しで掃除し_新しいものは残す() throws Exception {
        Path old = work("nb", "old.nii.gz");
        Path fresh = work("nb", "fresh.nii.gz").resolveSibling("..").resolve("job2").normalize();
        Files.createDirectories(fresh);
        Path freshFile = Files.write(fresh.resolve("fresh.nii.gz"), new byte[3]);
        Files.setLastModifiedTime(old.getParent(), FileTime.from(Instant.now().minus(3, ChronoUnit.HOURS)));
        controller(true, new Recording(), new Datasets()).export("nb", new PluginNiftiController.ExportRequest("S", "T"));
        assertThat(old).doesNotExist();
        assertThat(freshFile).exists();
    }

    // ── H79: 取り込み ───────────────────────────────────────────────

    @Test
    void 取り込みはそのプラグインの一時フォルダのファイルとサイドカーだけで_終わったら両方消す() throws Exception {
        PluginJobService jobs = new PluginJobService(registry(true));
        Recording rec = new Recording();
        PluginNiftiController c = new PluginNiftiController(registry(true), jobs, rec, new Datasets(), tmp);
        Path f = work("nb", "v.nii.gz");
        Path side = f.resolveSibling("v.json");
        Files.writeString(side, "{\"RepetitionTime\": 2.5}");
        ResponseEntity<Object> r = c.importNifti("nb", req(f, side));
        assertThat(r.getStatusCode().value()).isEqualTo(200);
        PluginJobService.Status st = await(jobs, ((PluginJobService.Status) r.getBody()).jobId());
        assertThat(st.state()).isEqualTo(PluginJobService.State.DONE);
        assertThat(rec.calls).isEqualTo(1);
        assertThat(rec.existedWhenImported).isTrue();
        assertThat(rec.metadata).containsEntry("RepetitionTime", 2.5);
        assertThat(rec.options.patientId()).isEqualTo("P1");
        assertThat(f).doesNotExist();
        assertThat(side).doesNotExist();
        assertThat(f.getParent()).doesNotExist();
    }

    @Test
    void 取り込みが失敗してもプラグインの一時ファイルは消える() throws Exception {
        PluginJobService jobs = new PluginJobService(registry(true));
        Recording rec = new Recording();
        rec.failWith = "壊れた画像";
        PluginNiftiController c = new PluginNiftiController(registry(true), jobs, rec, new Datasets(), tmp);
        Path f = work("nb", "bad.nii.gz");
        ResponseEntity<Object> r = c.importNifti("nb", req(f, null));
        PluginJobService.Status st = await(jobs, ((PluginJobService.Status) r.getBody()).jobId());
        assertThat(st.state()).isEqualTo(PluginJobService.State.FAILED);
        assertThat(f).doesNotExist();
    }

    @Test
    void 取り込みの負例_外_ほかのプラグイン_リンク_相対_サイドカーが外は断り_ジョブに入らず何も消さない() throws Exception {
        PluginJobService jobs = new PluginJobService(registry(true));
        Recording rec = new Recording();
        PluginNiftiController c = new PluginNiftiController(registry(true), jobs, rec, new Datasets(), tmp);
        Path outside = tmp.resolve("elsewhere.nii.gz");
        Files.write(outside, new byte[16]);
        assertThatThrownBy(() -> c.allowedPath("nb", outside.toString())).hasMessageContaining("一時フォルダ");
        Path others = work("other", "x.nii.gz");
        assertThatThrownBy(() -> c.allowedPath("nb", others.toString())).hasMessageContaining("このプラグイン");
        Path link = work("nb", "real.nii.gz").resolveSibling("link.nii.gz");
        Files.createSymbolicLink(link, outside);
        assertThatThrownBy(() -> c.allowedPath("nb", link.toString())).hasMessageContaining("一時フォルダ");
        Path dotdot = tmp.resolve(PluginNiftiController.WORK_DIR).resolve("nb").resolve("..").resolve("other").resolve("job1")
                .resolve("x.nii.gz");
        assertThatThrownBy(() -> c.allowedPath("nb", dotdot.toString())).hasMessageContaining("このプラグイン");
        assertThatThrownBy(() -> c.allowedPath("nb", "relative.nii.gz")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> c.allowedPath("nb", tmp.resolve(PluginNiftiController.WORK_DIR).resolve("nb").toString()))
                .isInstanceOf(IllegalArgumentException.class); // ディレクトリ
        assertThat(c.allowedPath("nb", work("nb", "ok.nii.gz").toString())).exists(); // 正例
        // 外のファイルを取り込もうとしても、ジョブに入らず 400。サイドカーが外なら、本体のファイルも消さない
        assertThat(c.importNifti("nb", req(outside, null)).getStatusCode().value()).isEqualTo(400);
        Path mine = work("nb", "m.nii.gz");
        assertThat(c.importNifti("nb", req(mine, outside)).getStatusCode().value()).isEqualTo(400);
        assertThat(mine).exists();
        assertThat(outside).exists();
        assertThat(rec.calls).isZero();
        // 登録外・standalone でない
        assertThat(c.importNifti("nobody", req(mine, null)).getStatusCode().value()).isEqualTo(404);
        assertThat(new PluginNiftiController(registry(false), jobs, rec, new Datasets(), tmp).importNifti("nb", req(mine, null))
                .getStatusCode().value()).isEqualTo(501);
    }

    @Test
    void probeは同じ規則で下読みする_壊れたファイルは400() throws Exception {
        PluginNiftiController c = controller(true, new Recording(), new Datasets());
        Path nii = work("nb", "ok.nii.gz");
        FloatNiftiFixture.write(nii, 4, 3, 2, 1.0, 1.0, 2.0, (i, j, k) -> i + j + k);
        ResponseEntity<Object> r = c.probe("nb", new PluginNiftiController.PathRequest(nii.toString()));
        assertThat(r.getStatusCode().value()).isEqualTo(200);
        NiftiImportController.Probe p = (NiftiImportController.Probe) r.getBody();
        assertThat(p.columns()).isEqualTo(4);
        assertThat(p.rows()).isEqualTo(3);
        assertThat(p.slices()).isEqualTo(2);
        assertThat(p.geometrySynthesized()).isFalse();
        assertThat(c.probe("nb", new PluginNiftiController.PathRequest(work("nb", "bad.nii.gz").toString())).getStatusCode().value())
                .isEqualTo(400);
        Path outside = tmp.resolve("e.nii.gz");
        Files.write(outside, new byte[16]);
        assertThat(c.probe("nb", new PluginNiftiController.PathRequest(outside.toString())).getStatusCode().value()).isEqualTo(400);
    }
}

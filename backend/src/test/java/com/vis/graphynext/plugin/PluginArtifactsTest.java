/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** H53: プラグインのジョブの成果物を預かる（一時フォルダの下のファイルだけ・移す・配る）。 */
class PluginArtifactsTest {

    @TempDir
    Path tmp;
    @TempDir
    Path elsewhere;

    @Test
    void 一時フォルダの下のファイルを預かり_結果を配れる形に差し替える() throws IOException {
        PluginArtifacts a = new PluginArtifacts(tmp);
        Path f = Files.writeString(tmp.resolve("uvs-export-1.mp4"), "video");
        Object out = a.adopt("job-1", Map.of("ok", true, PluginArtifacts.ARTIFACT_KEY, f.toString(),
                PluginArtifacts.ARTIFACT_NAME_KEY, "summary.mp4"));
        assertThat(out).isInstanceOf(Map.class);
        Map<?, ?> m = (Map<?, ?>) out;
        assertThat(m.get("ok")).isEqualTo(true);
        assertThat(m.containsKey(PluginArtifacts.ARTIFACT_NAME_KEY)).isFalse();
        assertThat(m.get(PluginArtifacts.ARTIFACT_KEY)).isEqualTo(new PluginArtifacts.Artifact("job-1", "summary.mp4", 5));
        assertThat(Files.exists(f)).isFalse(); // 移した
        assertThat(a.find("job-1")).hasValueSatisfying(p -> assertThat(p.getFileName().toString()).isEqualTo("summary.mp4"));
    }

    @Test
    void 一時フォルダの外のファイルは受け取らない_ファイルでないものも() throws IOException {
        PluginArtifacts a = new PluginArtifacts(tmp);
        Path outside = Files.writeString(elsewhere.resolve("secret.txt"), "x");
        assertThatThrownBy(() -> a.adopt("job-2", Map.of(PluginArtifacts.ARTIFACT_KEY, outside.toString())))
                .isInstanceOf(IOException.class).hasMessageContaining("一時フォルダ");
        assertThat(Files.exists(outside)).isTrue();
        assertThatThrownBy(() -> a.adopt("job-3", Map.of(PluginArtifacts.ARTIFACT_KEY, tmp.toString())))
                .isInstanceOf(IOException.class);
    }

    @Test
    void 成果物の無い結果はそのまま() throws IOException {
        PluginArtifacts a = new PluginArtifacts(tmp);
        Map<String, Object> r = Map.of("ok", true);
        assertThat(a.adopt("job-4", r)).isSameAs(r);
        assertThat(a.adopt("job-5", "text")).isEqualTo("text");
        assertThat(a.find("job-4")).isEmpty();
    }

    @Test
    void ジョブidやファイル名に使えない文字はパスを抜けさせない() throws IOException {
        PluginArtifacts a = new PluginArtifacts(tmp);
        Path p = a.place("../../evil", "../x.dcm");
        // 🔑 本体は一時フォルダを実パスで扱う（macOS の /var → /private/var・Windows の短い名前）。比べる側も実パスにする
        assertThat(p.normalize().startsWith(tmp.toRealPath().resolve("graphy-plugin-artifacts"))).isTrue();
    }
}

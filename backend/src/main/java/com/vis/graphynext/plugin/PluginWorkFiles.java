/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;

/**
 * プラグインが本体へ渡すファイル（H68 の顕微鏡の画素・H79 の NIfTI など）の置き場の規則。
 *
 * <p>受け付けるのは {@code <java.io.tmpdir>/<作業フォルダ名>/<プラグイン ID>/} の下の、実在する通常のファイルだけ
 * （シンボリックリンク・ほかのプラグインのフォルダ・その外は断る）。任意のパスを受ける本体の取り込みの口を、
 * プラグインに使わせないための共通の検査（口ごとに書き写さず、1 か所に置く）。
 */
public final class PluginWorkFiles {

    private PluginWorkFiles() {
    }

    /**
     * そのプラグインの作業フォルダの下の、実在する通常のファイル（リンクを辿らない）。それ以外は理由つきで断る。
     *
     * @return たどった先の実際のパス
     * @throws IllegalArgumentException パスが無い・プラグイン ID が不正・通常のファイルでない・作業フォルダの外
     */
    public static Path allowedPath(Path tmpRoot, String workDir, String pluginId, String path) throws IOException {
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
        // ファイルそのものがリンクなら上で断った。途中のフォルダのリンクはたどって実際の場所で比べる
        // （macOS の一時フォルダ /var/folders は /private/var/folders へのリンク。たどらないと正しいファイルまで断る。
        //  プラグインのフォルダの中に外を指すリンクを置かれても、たどった先が外になるので断れる）
        Path real = p.toRealPath();
        Path dir = tmpRoot.resolve(workDir).resolve(pluginId);
        Path realDir = Files.isDirectory(dir) ? dir.toRealPath() : dir.toAbsolutePath().normalize();
        if (!real.startsWith(realDir)) {
            throw new IllegalArgumentException("このプラグインの一時フォルダのファイルだけを取り込めます");
        }
        return real;
    }
}

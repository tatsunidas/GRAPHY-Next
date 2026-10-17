/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.nifti;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;

/**
 * .hdr＋.img の 2 ファイル形式（ANALYZE 7.5・NIfTI の 2 ファイル形式）の対を解く（fw/nifti-import.md §9）。
 * どちらを選んでも同じ対になる。画素は .img、無ければ .img.gz。
 *
 * @param header .hdr
 * @param data   .img または .img.gz
 */
public record NiftiPair(Path header, Path data) {

    /** 2 ファイル形式として扱う拡張子か（.hdr／.img／.img.gz。大文字小文字は問わない）。 */
    public static boolean isPairPath(Path p) {
        String n = p.getFileName().toString().toLowerCase(Locale.ROOT);
        return n.endsWith(".hdr") || n.endsWith(".img") || n.endsWith(".img.gz");
    }

    public static NiftiPair resolve(Path selected) throws IOException {
        String name = selected.getFileName().toString();
        String lower = name.toLowerCase(Locale.ROOT);
        String stem;
        if (lower.endsWith(".img.gz")) {
            stem = name.substring(0, name.length() - 7);
        } else if (lower.endsWith(".hdr") || lower.endsWith(".img")) {
            stem = name.substring(0, name.length() - 4);
        } else {
            throw new IOException(".hdr／.img のファイルではありません: " + name);
        }
        Path dir = selected.toAbsolutePath().getParent();
        Path hdr = find(dir, stem, List.of(".hdr", ".HDR", ".Hdr"));
        Path img = find(dir, stem, List.of(".img", ".IMG", ".Img", ".img.gz", ".IMG.GZ", ".img.GZ", ".Img.gz"));
        if (hdr == null) {
            throw new IOException("対になる .hdr が見つかりません: " + stem + ".hdr");
        }
        if (img == null) {
            throw new IOException("対になる .img（または .img.gz）が見つかりません: " + stem + ".img");
        }
        return new NiftiPair(hdr, img);
    }

    private static Path find(Path dir, String stem, List<String> exts) {
        for (String e : exts) {
            Path p = dir.resolve(stem + e);
            if (Files.isRegularFile(p)) {
                return p;
            }
        }
        return null;
    }

    /** ヘッダを読み、画素ファイルの圧縮を拡張子で決める。 */
    public NiftiHeader readHeader() throws IOException {
        byte[] head;
        try (InputStream in = Files.newInputStream(header)) {
            head = in.readNBytes(NiftiHeader.NIFTI2_HEADER_SIZE);
        }
        NiftiHeader h = NiftiHeader.parsePair(head);
        h.dataGzip = data.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".gz");
        return h;
    }
}

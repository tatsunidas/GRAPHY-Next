/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dbtransfer;

import com.vis.graphynext.dbtransfer.TransferManifest.PluginDocItem;
import com.vis.graphynext.dbtransfer.TransferManifest.PluginVersion;
import com.vis.graphynext.plugin.PluginManifest;
import com.vis.graphynext.plugin.PluginRegistry;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeSet;

/**
 * 荷物のプラグインの記録について、移し元と移し先の版を突き合わせる。
 *
 * <p>知らせるだけで、取り込みは止めない。本体は記録の中身を解釈しないので、版が違って読めるかはプラグインが決める。
 */
public final class PluginVersions {

    /** {@code missing}: 移し先に無い。{@code different}: 版が違う。{@code unknown}: 移し元の版が分からない。 */
    public record Note(String id, String sourceVersion, String localVersion, String kind) {
    }

    private PluginVersions() {
    }

    static Map<String, String> installed(PluginRegistry registry) {
        Map<String, String> out = new LinkedHashMap<>();
        for (PluginManifest m : registry.manifests()) {
            out.put(m.id(), m.version());
        }
        return out;
    }

    private static TreeSet<String> ids(TransferManifest.Related rel) {
        TreeSet<String> ids = new TreeSet<>();
        if (rel != null && rel.plugins() != null) {
            for (PluginDocItem d : rel.plugins()) {
                ids.add(d.pluginId());
            }
        }
        return ids;
    }

    static List<PluginVersion> ofSource(TransferManifest.Related rel, Map<String, String> installed) {
        return ids(rel).stream().map(id -> new PluginVersion(id, installed.get(id))).toList();
    }

    static List<Note> compare(TransferManifest m, Map<String, String> installed) {
        Map<String, String> source = new LinkedHashMap<>();
        if (m.pluginVersions() != null) {
            for (PluginVersion v : m.pluginVersions()) {
                source.put(v.id(), v.version());
            }
        }
        List<Note> out = new ArrayList<>();
        for (String id : ids(m.related())) {
            String from = source.get(id);
            if (!installed.containsKey(id)) {
                out.add(new Note(id, from, null, "missing"));
            } else if (from == null) {
                out.add(new Note(id, null, installed.get(id), "unknown"));
            } else if (!Objects.equals(from, installed.get(id))) {
                out.add(new Note(id, from, installed.get(id), "different"));
            }
        }
        return out;
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.vis.graphynext.plugin.PluginManifest;
import com.vis.graphynext.plugin.PluginRegistry;
import com.vis.graphynext.plugin.manager.InstalledPlugin;
import com.vis.graphynext.plugin.manager.PluginManagerService;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

/**
 * 台帳に書くプラグインの素性（名前・版・導入した zip の SHA-256）を、プラグインの登録簿と導入台帳から引く。
 * 台帳に無いもの（同梱・開発配置）の SHA-256 は null＝「不明」のまま（推測で埋めない）。
 */
@Component
class ComputePluginFacts implements ComputeJobLedger.PluginFactsResolver {

    private final ObjectProvider<PluginRegistry> registry;
    private final ObjectProvider<PluginManagerService> manager;

    ComputePluginFacts(ObjectProvider<PluginRegistry> registry, ObjectProvider<PluginManagerService> manager) {
        this.registry = registry;
        this.manager = manager;
    }

    @Override
    public ComputeJobLedger.PluginFacts of(String pluginId) {
        String name = null;
        String version = null;
        PluginRegistry r = registry.getIfAvailable();
        if (r != null) {
            for (PluginManifest m : r.manifests()) {
                if (m.id().equals(pluginId)) {
                    name = m.name();
                    version = m.version();
                }
            }
        }
        String sha = null;
        PluginManagerService mgr = manager.getIfAvailable();
        if (mgr != null) {
            for (InstalledPlugin p : mgr.installed()) {
                if (p.id().equals(pluginId)) {
                    sha = p.sha256();
                    if (version == null) {
                        version = p.version();
                    }
                }
            }
        }
        return new ComputeJobLedger.PluginFacts(name, version, sha);
    }
}

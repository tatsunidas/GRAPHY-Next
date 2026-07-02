/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/** プラグイン設定の有効化。{@link PluginProperties}（graphy.plugins.*）を束縛する。 */
@Configuration
@EnableConfigurationProperties(PluginProperties.class)
public class PluginConfig {
}

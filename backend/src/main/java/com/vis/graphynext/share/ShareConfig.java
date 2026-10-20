/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.share;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/** {@link ShareProperties} を束縛する。共有の各部品は {@code graphy.share.enabled=true} のときだけ生える。 */
@Configuration
@EnableConfigurationProperties(ShareProperties.class)
public class ShareConfig {
}

package com.vis.graphynext.dicom;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;

/**
 * DICOM 関連の設定有効化。{@link DicomProperties}（graphy.dicom.*）を束縛する。
 */
@Configuration
@EnableConfigurationProperties(DicomProperties.class)
public class DicomConfig {
}

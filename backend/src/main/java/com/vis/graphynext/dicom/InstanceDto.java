/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom;

/**
 * インスタンス一覧の 1 行（standalone=H2 / web=QIDO 共通）。
 */
public record InstanceDto(String sopInstanceUid, Integer instanceNumber, String sopClassUid) {
}

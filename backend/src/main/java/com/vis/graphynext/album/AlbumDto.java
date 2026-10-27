/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.album;

import java.time.Instant;

public record AlbumDto(Long id, String name, Instant createdAt, long count) {
}

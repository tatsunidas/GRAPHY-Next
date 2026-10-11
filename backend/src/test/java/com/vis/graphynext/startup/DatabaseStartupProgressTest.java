/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.startup;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** データベースの段階は entityManagerFactory の初期化の前後だけ。ほかの部品では何も報告しない。 */
class DatabaseStartupProgressTest {

    @Test
    void entityManagerFactory_の前後で一度だけ段階を切り替え_ほかの部品では何もしない() {
        List<String> seen = new ArrayList<>();
        DatabaseStartupProgress p = new DatabaseStartupProgress((step, state, msg) -> seen.add(step + ":" + state));

        p.postProcessBeforeInitialization(new Object(), "someService");
        p.postProcessAfterInitialization(new Object(), "someService");
        assertEquals(List.of(), seen);

        p.postProcessBeforeInitialization(new Object(), "entityManagerFactory");
        p.postProcessAfterInitialization(new Object(), "entityManagerFactory");
        p.postProcessAfterInitialization(new Object(), "entityManagerFactory"); // FactoryBean の本体の分（2 回目）
        assertEquals(List.of("context:ok", "database:running", "database:ok", "services:running"), seen);
    }
}

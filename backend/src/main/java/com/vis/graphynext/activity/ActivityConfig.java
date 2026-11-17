/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.activity;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
class ActivityConfig {

    @Bean
    ProcessExiter processExiter() {
        return System::exit;
    }

    /** フィルターが数えている実体を、ActivityService に渡す。 */
    @Bean
    InFlightRequests inFlightRequests(InFlightRequestFilter filter) {
        return filter.tracker();
    }
}

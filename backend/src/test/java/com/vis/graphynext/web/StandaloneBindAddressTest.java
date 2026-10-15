/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.web;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.core.env.PropertySource;
import org.springframework.core.io.ClassPathResource;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.nio.file.Path;
import java.util.Collections;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * standalone の HTTP は、この PC（127.0.0.1）からだけ受ける。認証が無いので LAN に開くと
 * 同じ LAN の誰でも患者情報を読める・書き換えられる（実測で /api/studies が LAN から読めた）。
 * web モード（デモサーバーなど）は全体で待ち受けたまま。
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                "spring.profiles.active=standalone",
                "spring.datasource.url=jdbc:h2:mem:bindaddr;DB_CLOSE_DELAY=-1",
                "graphy.dicom.scp.enabled=false"
        })
class StandaloneBindAddressTest {

    @TempDir
    static Path tmp;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry r) {
        r.add("graphy.dicom.storage-dir", () -> tmp.resolve("dicom").toString());
        r.add("graphy.plugins.dir", () -> tmp.resolve("plugins").toString());
    }

    @Autowired
    WebServerApplicationContext ctx;

    private static Optional<Object> yamlValue(String file, String key) throws IOException {
        List<PropertySource<?>> ps = new YamlPropertySourceLoader().load(file, new ClassPathResource(file));
        return ps.stream().map(p -> p.getProperty(key)).filter(v -> v != null).findFirst();
    }

    @Test
    void 設定_standaloneは127_0_0_1_webは未指定() throws IOException {
        assertEquals("127.0.0.1", String.valueOf(yamlValue("application-standalone.yml", "server.address").orElse(null)));
        assertNull(yamlValue("application.yml", "server.address").orElse(null), "共通の設定で絞ると web も絞られる");
        assertNull(yamlValue("application-web.yml", "server.address").orElse(null));
    }

    @Test
    void 実際に_この_PC_からはつながり_LAN_の_IP_からはつながらない() throws IOException {
        int port = ctx.getWebServer().getPort();
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 2000);
        }
        InetAddress lan = lanAddress();
        Assumptions.assumeTrue(lan != null, "LAN の IPv4 アドレスが無い環境");
        assertThrows(IOException.class, () -> {
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress(lan, port), 2000);
            }
        }, "LAN の IP " + lan + " から接続できてしまう");
    }

    private static InetAddress lanAddress() throws IOException {
        for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
            if (!ni.isUp() || ni.isLoopback()) {
                continue;
            }
            for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                if (a instanceof Inet4Address && !a.isLoopbackAddress() && !a.isLinkLocalAddress()) {
                    return a;
                }
            }
        }
        return null;
    }
}

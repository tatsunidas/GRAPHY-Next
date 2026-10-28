/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.dicom.discovery;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * macOS の mDNS（OS 標準の {@code dns-sd} コマンドを子プロセスで呼ぶ）。
 * macOS は mDNSResponder が UDP 5353 を持っていて、JmDNS が NIC のアドレスへ bind できない（CI の実測）ため。
 * 引数は配列で渡す（shell を通さない）。広告は子プロセスを保持して停止時に終了させ、探索は短時間で必ず終了させる。
 * 出力の書式は macOS 26 の CI ランナーで実測したもの（{@code DnsSdEngineParseTest} の試験データ）。
 */
final class DnsSdEngine implements MdnsEngine {

    private static final Logger log = LoggerFactory.getLogger(DnsSdEngine.class);
    private static final String SHORT_TYPE = "_dicom._tcp";
    private static final int REGISTER_WAIT_MILLIS = 5000;
    private static final int BROWSE_MILLIS = 3000;
    private static final int RESOLVE_MILLIS = 2000;
    private static final int ADDRESS_MILLIS = 1500;

    // ---------------------------------------------------------------- 広告

    @Override
    public Advertisement advertise(String name, int port, Map<String, String> txt, List<InetAddress> addresses)
            throws IOException {
        List<String> cmd = new ArrayList<>(List.of("dns-sd", "-R", name, SHORT_TYPE, "local", String.valueOf(port)));
        txt.forEach((k, v) -> cmd.add(k + "=" + v));
        Proc p = Proc.start(cmd);
        if (!p.awaitLine(DnsSdEngine::isRegistered, REGISTER_WAIT_MILLIS)) {
            String out = p.output();
            p.stop();
            throw new IOException("dns-sd が登録を確認できません: " + out.strip());
        }
        log.info("mDNS 広告を開始（dns-sd）: {} {} port={}", TYPE, name, port);
        return p::stop;
    }

    static boolean isRegistered(String line) {
        return line.contains("Name now registered and active");
    }

    // ---------------------------------------------------------------- 探索

    @Override
    public List<Peer> browse(List<InetAddress> addresses) throws IOException {
        Proc b = Proc.start(List.of("dns-sd", "-B", SHORT_TYPE, "local"));
        b.sleep(BROWSE_MILLIS);
        b.stop();
        Set<String> names = parseBrowse(b.lines());
        List<Peer> out = new ArrayList<>();
        List<Thread> threads = new ArrayList<>();
        for (String name : names) {
            Thread t = new Thread(() -> {
                try {
                    Peer peer = resolve(name);
                    if (peer != null) {
                        synchronized (out) {
                            out.add(peer);
                        }
                    }
                } catch (IOException e) {
                    log.debug("dns-sd で {} を解決できません: {}", name, e.toString());
                }
            }, "dicom-discovery-resolve");
            t.setDaemon(true);
            threads.add(t);
            t.start();
        }
        for (Thread t : threads) {
            try {
                t.join();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        return out;
    }

    private Peer resolve(String name) throws IOException {
        Proc l = Proc.start(List.of("dns-sd", "-L", name, SHORT_TYPE, "local"));
        l.sleep(RESOLVE_MILLIS);
        l.stop();
        Resolved r = parseLookup(l.lines());
        if (r == null) {
            return null;
        }
        Proc g = Proc.start(List.of("dns-sd", "-G", "v4", r.host()));
        g.sleep(ADDRESS_MILLIS);
        g.stop();
        String address = parseAddress(g.lines());
        if (address == null) {
            return null;
        }
        return new Peer(name, r.txt().get("aet"), address, r.port(), r.txt().get("tls"), r.txt().get("tlsPort"));
    }

    // ---------------------------------------------------------------- 解析（純関数。実測した出力が試験データ）

    /** {@code dns-sd -L} の結果。 */
    record Resolved(String host, int port, Map<String, String> txt) {
    }

    private static final Pattern BROWSE_LINE =
            Pattern.compile("^\\S+\\s+Add\\s+\\d+\\s+\\d+\\s+\\S+\\s+\\S+\\s+(.+)$");
    private static final Pattern REACHED = Pattern.compile("can be reached at (\\S+?):(\\d+) \\(interface");
    private static final Pattern ADDRESS_LINE =
            Pattern.compile("^\\S+\\s+Add\\s+\\S+\\s+\\S+\\s+\\S+\\s+(\\d+\\.\\d+\\.\\d+\\.\\d+)\\s+\\d+");

    /** {@code dns-sd -B} の出力から、見つかったインスタンス名（重複なし）。 */
    static Set<String> parseBrowse(List<String> lines) {
        Set<String> names = new LinkedHashSet<>();
        for (String line : lines) {
            Matcher m = BROWSE_LINE.matcher(line);
            if (m.matches()) {
                names.add(m.group(1).strip());
            }
        }
        return names;
    }

    /** {@code dns-sd -L} の出力から、ホスト・ポート・TXT。最初に TXT まで揃った組。無ければ null。 */
    static Resolved parseLookup(List<String> lines) {
        for (int i = 0; i < lines.size(); i++) {
            Matcher m = REACHED.matcher(lines.get(i));
            if (m.find() && i + 1 < lines.size() && lines.get(i + 1).startsWith(" ")) {
                return new Resolved(m.group(1), Integer.parseInt(m.group(2)), parseTxt(lines.get(i + 1)));
            }
        }
        return null;
    }

    /** TXT の行（先頭が空白、項目は空白区切りで、値の空白は {@code \ }）を key→value にする。 */
    static Map<String, String> parseTxt(String line) {
        Map<String, String> txt = new LinkedHashMap<>();
        StringBuilder cur = new StringBuilder();
        List<String> tokens = new ArrayList<>();
        String s = line.strip();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\\' && i + 1 < s.length()) {
                // \ddd（10 進 3 桁）か \x（x をそのまま）
                if (i + 3 < s.length() && isDigits(s, i + 1, i + 4)) {
                    cur.append((char) Integer.parseInt(s.substring(i + 1, i + 4)));
                    i += 3;
                } else {
                    cur.append(s.charAt(i + 1));
                    i++;
                }
            } else if (c == ' ') {
                if (cur.length() > 0) {
                    tokens.add(cur.toString());
                    cur.setLength(0);
                }
            } else {
                cur.append(c);
            }
        }
        if (cur.length() > 0) {
            tokens.add(cur.toString());
        }
        for (String t : tokens) {
            int eq = t.indexOf('=');
            if (eq > 0) {
                txt.put(t.substring(0, eq), t.substring(eq + 1));
            }
        }
        return txt;
    }

    private static boolean isDigits(String s, int from, int to) {
        for (int i = from; i < to; i++) {
            if (!Character.isDigit(s.charAt(i))) {
                return false;
            }
        }
        return true;
    }

    /** {@code dns-sd -G v4} の出力から IPv4 アドレス（最初の Add 行）。無ければ null。 */
    static String parseAddress(List<String> lines) {
        for (String line : lines) {
            Matcher m = ADDRESS_LINE.matcher(line);
            if (m.find()) {
                return m.group(1);
            }
        }
        return null;
    }

    // ---------------------------------------------------------------- 子プロセス

    /** 子プロセスと、その出力の行。必ず {@link #stop()} で終わらせる。 */
    static final class Proc {
        private final Process process;
        private final List<String> lines = new ArrayList<>();

        private Proc(Process process) {
            this.process = process;
        }

        static Proc start(List<String> cmd) throws IOException {
            Process process = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            Proc p = new Proc(process);
            Thread t = new Thread(() -> {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = r.readLine()) != null) {
                        synchronized (p.lines) {
                            p.lines.add(line);
                        }
                    }
                } catch (IOException ignore) {
                    // 終了時
                }
            }, "dns-sd-reader");
            t.setDaemon(true);
            t.start();
            return p;
        }

        boolean awaitLine(Predicate<String> match, long timeoutMillis) {
            long end = System.nanoTime() + timeoutMillis * 1_000_000L;
            while (System.nanoTime() < end) {
                if (lines().stream().anyMatch(match)) {
                    return true;
                }
                if (!process.isAlive()) {
                    return lines().stream().anyMatch(match);
                }
                sleep(50);
            }
            return false;
        }

        void sleep(long millis) {
            try {
                Thread.sleep(millis);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        List<String> lines() {
            synchronized (lines) {
                return new ArrayList<>(lines);
            }
        }

        String output() {
            return String.join("\n", lines());
        }

        void stop() {
            process.destroy();
            try {
                if (!process.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                process.destroyForcibly();
            }
        }
    }
}

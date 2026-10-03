/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ExecutionCollectorTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private ObjectNode msg(String parent, String type, String content) throws Exception {
        ObjectNode m = mapper.createObjectNode();
        m.set("header", mapper.createObjectNode().put("msg_type", type).put("msg_id", "x"));
        m.set("parent_header", mapper.createObjectNode().put("msg_id", parent));
        m.set("content", mapper.readTree(content));
        return m;
    }

    @Test
    void completesOnlyAfterBothReplyAndIdle_replyFirst() throws Exception {
        ExecutionCollector c = new ExecutionCollector("m1", null);
        c.accept(msg("m1", "status", "{\"execution_state\":\"busy\"}"));
        c.accept(msg("m1", "stream", "{\"name\":\"stdout\",\"text\":\"a\\n\"}"));
        c.accept(msg("m1", "execute_reply", "{\"status\":\"ok\",\"execution_count\":3}"));
        assertFalse(c.future().isDone(), "reply だけでは終わらない（後続の stdout を取りこぼす）");
        c.accept(msg("m1", "stream", "{\"name\":\"stdout\",\"text\":\"b\\n\"}"));
        c.accept(msg("m1", "status", "{\"execution_state\":\"idle\"}"));
        ExecutionResult r = c.future().getNow(null);
        assertTrue(r.ok());
        assertEquals("a\nb\n", r.stdout());
        assertEquals(3, r.executionCount());
    }

    @Test
    void completesOnlyAfterBothReplyAndIdle_idleFirst() throws Exception {
        ExecutionCollector c = new ExecutionCollector("m1", null);
        c.accept(msg("m1", "status", "{\"execution_state\":\"idle\"}"));
        assertFalse(c.future().isDone());
        c.accept(msg("m1", "execute_reply", "{\"status\":\"ok\"}"));
        assertTrue(c.future().isDone());
    }

    @Test
    void ignoresMessagesForOtherRequests() throws Exception {
        ExecutionCollector c = new ExecutionCollector("m1", null);
        assertFalse(c.accept(msg("other", "stream", "{\"name\":\"stdout\",\"text\":\"x\"}")));
        c.accept(msg("m1", "execute_reply", "{\"status\":\"ok\"}"));
        c.accept(msg("m1", "status", "{\"execution_state\":\"idle\"}"));
        assertEquals("", c.future().getNow(null).stdout());
    }

    @Test
    void collectsErrorWithoutAnsiColors() throws Exception {
        ExecutionCollector c = new ExecutionCollector("m1", null);
        c.accept(msg("m1", "error", "{\"ename\":\"ValueError\",\"evalue\":\"bad\","
                + "\"traceback\":[\"\\u001b[0;31mValueError\\u001b[0m: bad\"]}"));
        c.accept(msg("m1", "execute_reply", "{\"status\":\"error\",\"ename\":\"ValueError\",\"evalue\":\"bad\"}"));
        c.accept(msg("m1", "status", "{\"execution_state\":\"idle\"}"));
        ExecutionResult r = c.future().getNow(null);
        assertFalse(r.ok());
        assertEquals("ValueError", r.errorName());
        assertEquals(List.of("ValueError: bad"), r.traceback());
    }

    @Test
    void collectsRichOutputsAndNotifiesStreams() throws Exception {
        List<String> seen = new ArrayList<>();
        ExecutionCollector c = new ExecutionCollector("m1", (name, text) -> seen.add(name + ":" + text));
        c.accept(msg("m1", "stream", "{\"name\":\"stderr\",\"text\":\"warn\"}"));
        c.accept(msg("m1", "execute_result", "{\"data\":{\"text/plain\":\"42\"},\"execution_count\":1}"));
        c.accept(msg("m1", "display_data", "{\"data\":{\"image/png\":\"iVBOR\",\"text/plain\":[\"<Fig\",\"ure>\"]}}"));
        c.accept(msg("m1", "execute_reply", "{\"status\":\"ok\"}"));
        c.accept(msg("m1", "status", "{\"execution_state\":\"idle\"}"));
        ExecutionResult r = c.future().getNow(null);
        assertEquals("42", r.textPlain());
        assertEquals("iVBOR", r.outputs().get(1).get("image/png"));
        assertEquals("<Figure>", r.outputs().get(1).get("text/plain"));
        assertEquals("warn", r.stderr());
        assertEquals(List.of("stderr:warn"), seen);
    }

    @Test
    void truncatesHugeStdout() throws Exception {
        ExecutionCollector c = new ExecutionCollector("m1", null);
        String chunk = "x".repeat(400_000);
        for (int i = 0; i < 4; i++) {
            c.accept(msg("m1", "stream", "{\"name\":\"stdout\",\"text\":\"" + chunk + "\"}"));
        }
        c.accept(msg("m1", "execute_reply", "{\"status\":\"ok\"}"));
        c.accept(msg("m1", "status", "{\"execution_state\":\"idle\"}"));
        String out = c.future().getNow(null).stdout();
        assertEquals(ExecutionCollector.MAX_STREAM_CHARS + ExecutionCollector.TRUNCATED.length(), out.length());
        assertTrue(out.endsWith(ExecutionCollector.TRUNCATED));
    }
}

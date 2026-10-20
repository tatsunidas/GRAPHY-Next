/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.compute;

import com.vis.graphynext.compute.ComputeJobStateMachine.Reason;
import com.vis.graphynext.compute.ComputeJobStateMachine.State;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.EnumSet;
import java.util.Set;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ComputeJobStateMachineTest {

    /** 設計 §1.1 の表（これ以外は通さない）。 */
    private static Set<State> allowedFrom(State s) {
        return switch (s) {
            case QUEUED -> EnumSet.of(State.RUNNING, State.CANCELLED, State.INTERRUPTED);
            case RUNNING -> EnumSet.of(State.DONE, State.FAILED, State.CANCELLED, State.AWAITING_USER, State.INTERRUPTED);
            case AWAITING_USER ->
                    EnumSet.of(State.RUNNING, State.DONE, State.FAILED, State.CANCELLED, State.INTERRUPTED);
            default -> EnumSet.noneOf(State.class);
        };
    }

    @Test
    void everyPairIsDecidedByTheTable() {
        for (State from : State.values()) {
            for (State to : State.values()) {
                boolean expected = allowedFrom(from).contains(to);
                assertEquals(expected, ComputeJobStateMachine.allowed(from, to), from + " -> " + to);
                if (expected) {
                    assertEquals(to, ComputeJobStateMachine.move(from, to));
                } else {
                    assertThrows(IllegalStateException.class, () -> ComputeJobStateMachine.move(from, to),
                            "🔴 表に無い遷移は通さない: " + from + " -> " + to);
                }
            }
        }
    }

    @Test
    void endedStatesAreTerminal() {
        for (State s : State.values()) {
            assertEquals(s == State.DONE || s == State.FAILED || s == State.CANCELLED || s == State.INTERRUPTED,
                    s.ended(), s.name());
            if (s.ended()) {
                assertTrue(allowedFrom(s).isEmpty(), s.name());
            }
        }
    }

    @Test
    void classifiesFailuresByTheirCause() {
        assertEquals(Reason.TIMEOUT, ComputeJobStateMachine.classify(new IllegalStateException("timeout after 60s")));
        assertEquals(Reason.DATASET_CHANGED,
                ComputeJobStateMachine.classify(new IllegalStateException("dataset changed after approval")));
        assertEquals(Reason.DATASET_EXPIRED, ComputeJobStateMachine.classify(new IllegalStateException("dataset expired")));
        assertEquals(Reason.OUTPUTS_TOO_LARGE, ComputeJobStateMachine.classify(new IllegalStateException("outputs too large")));
        assertEquals(Reason.OUTPUTS_TOO_LARGE,
                ComputeJobStateMachine.classify(new IllegalStateException("too many output files: 99")));
        assertEquals(Reason.ENDPOINT_UNREACHABLE, ComputeJobStateMachine.classify(new JupyterException("refused", 0)));
        assertEquals(Reason.ENDPOINT_UNREACHABLE, ComputeJobStateMachine.classify(new RuntimeException(new IOException("x"))));
        assertEquals(Reason.ENDPOINT_UNREACHABLE, ComputeJobStateMachine.classify(new RuntimeException(new TimeoutException())));
        assertEquals(Reason.ENDPOINT_UNREACHABLE,
                ComputeJobStateMachine.classify(new IllegalStateException("endpoint no longer registered: local")));
        assertEquals(Reason.INTERNAL, ComputeJobStateMachine.classify(new IllegalStateException("something else")));
    }

    @Test
    void reasonCodesAreUnique() {
        long distinct = java.util.Arrays.stream(Reason.values()).map(r -> r.code).distinct().count();
        assertEquals(Reason.values().length, distinct);
        assertFalse(Reason.CODE_ERROR.code.isBlank());
    }
}

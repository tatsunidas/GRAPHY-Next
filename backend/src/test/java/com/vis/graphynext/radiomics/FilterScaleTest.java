/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.radiomics;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class FilterScaleTest {

    @Test
    void conversionFormulas() {
        assertEquals(2.8284, FilterScale.sigmaMm(4, 2, FilterScale.Conversion.SQRT_D, null));
        assertEquals(2.3094, FilterScale.sigmaMm(4, 3, FilterScale.Conversion.SQRT_D, null));
        assertEquals(4.0, FilterScale.sigmaMm(4, 2, FilterScale.Conversion.IDENTITY, null));
        assertEquals(6.0, FilterScale.sigmaMm(4, 3, FilterScale.Conversion.COEFFICIENT, 1.5));
    }

    @Test
    void widthInPixelsIsTheDiameterAndCarriesNoFloatingPointNoise() {
        assertEquals(1.96, FilterScale.radiusMmFromWidthPx(4, 0.98));
        assertEquals(1.0, FilterScale.radiusMmFromWidthPx(4, 0.5));
        assertEquals(2.1, FilterScale.radiusMmFromWidthPx(6, 0.7), "6 × 0.7 / 2 は 2.0999999999999996 にしない");
        assertEquals(4.2, FilterScale.radiusMmFromWidthPx(12, 0.7));
        assertEquals(0.0, FilterScale.radiusMmFromWidthPx(0, 0.7));
        assertThrows(IllegalArgumentException.class, () -> FilterScale.radiusMmFromWidthPx(-1, 0.7));
        assertThrows(IllegalArgumentException.class, () -> FilterScale.radiusMmFromWidthPx(4, 0));
        assertThrows(IllegalArgumentException.class, () -> FilterScale.radiusMmFromWidthPx(Double.NaN, 0.7));
    }

    @Test
    void zeroMeansNoFilter() {
        assertNull(FilterScale.sigmaMm(0, 3, FilterScale.Conversion.SQRT_D, null));
    }

    @Test
    void invalidInputsAreRefused() {
        assertThrows(IllegalArgumentException.class, () -> FilterScale.sigmaMm(-1, 3, FilterScale.Conversion.SQRT_D, null));
        assertThrows(IllegalArgumentException.class,
                () -> FilterScale.sigmaMm(Double.NaN, 3, FilterScale.Conversion.SQRT_D, null));
        assertThrows(IllegalArgumentException.class,
                () -> FilterScale.sigmaMm(2, 3, FilterScale.Conversion.COEFFICIENT, null));
        assertThrows(IllegalArgumentException.class,
                () -> FilterScale.sigmaMm(2, 3, FilterScale.Conversion.COEFFICIENT, 0.0));
        assertThrows(IllegalArgumentException.class, () -> FilterScale.sigmaMm(0.00001, 3, FilterScale.Conversion.SQRT_D, null));
        assertThrows(IllegalArgumentException.class, () -> FilterScale.parse("nope"));
        assertEquals(FilterScale.Conversion.SQRT_D, FilterScale.parse(null));
    }

    @Test
    void settingValueHasNoTrailingZeros() {
        assertEquals("2.1213", FilterScale.settingValue(2.1213));
        assertEquals("3", FilterScale.settingValue(3.0));
    }
}

/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.plugin;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * プラグインが {@code plugin.json} の {@code aiTools[]} で宣言する、AI アシスタント向けのツール 1 件。
 *
 * <p>宣言は信頼できない入力。{@link #sanitize} が**作り直した**値だけを配信する（元の Map をそのまま渡さない）。
 * 通らないツールは黙って捨てず、理由をログに残して捨てる。この段階で許すのは読み取り・表示のツールだけ
 * （{@code effect} は {@code read} / {@code display}）。データを書くツールは宣言されても出さない。
 *
 * <p>引数の型は 2D 窓の {@code registry.ts} の {@code ParamSpec} と同じ閉じた集合
 * （number / integer / string / enum。境界必須・ネスト無し）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AiToolSpec(String name, String description, String effect, Map<String, Object> parameters) {

    /** 利用者が AI からの呼び出しを許す権限（plugin.json の permissions）。 */
    public static final String PERMISSION = "ai-tools";
    public static final int MAX_TOOLS_PER_PLUGIN = 8;
    public static final int MAX_DESCRIPTION = 300;
    public static final int MAX_PARAMS = 8;
    public static final int MAX_ENUM_VALUES = 16;
    public static final int MAX_STRING_LENGTH = 1000;
    private static final int MAX_PARAM_DESCRIPTION = 200;
    private static final int MAX_ENUM_VALUE_LENGTH = 40;
    private static final Pattern TOOL_NAME = Pattern.compile("^[a-z][a-z0-9_]{0,39}$");
    private static final Pattern PARAM_NAME = Pattern.compile("^[a-z][A-Za-z0-9_]{0,39}$");
    private static final List<String> EFFECTS = List.of("read", "display");

    /**
     * 宣言を検査して配信形に作り直す。{@code permissions} に {@value #PERMISSION} が無ければ空。
     * 1 件ごとに独立して検査し、通ったものだけを返す。理由は {@code reject} に渡す（ログ用）。
     */
    static List<AiToolSpec> sanitize(List<Map<String, Object>> raw, List<String> permissions,
                                     java.util.function.Consumer<String> reject) {
        if (raw == null || raw.isEmpty()) return List.of();
        if (permissions == null || !permissions.contains(PERMISSION)) {
            reject.accept("aiTools declared without the '" + PERMISSION + "' permission");
            return List.of();
        }
        List<AiToolSpec> out = new ArrayList<>();
        for (Map<String, Object> t : raw) {
            if (out.size() >= MAX_TOOLS_PER_PLUGIN) {
                reject.accept("more than " + MAX_TOOLS_PER_PLUGIN + " aiTools (extra ones dropped)");
                break;
            }
            String why = null;
            AiToolSpec spec = null;
            try {
                spec = one(t, out);
            } catch (IllegalArgumentException e) {
                why = e.getMessage();
            }
            if (spec != null) out.add(spec);
            else reject.accept("aiTool dropped: " + why);
        }
        return List.copyOf(out);
    }

    private static AiToolSpec one(Map<String, Object> t, List<AiToolSpec> already) {
        if (t == null) throw new IllegalArgumentException("null entry");
        for (String k : t.keySet()) {
            if (!List.of("name", "description", "effect", "parameters").contains(k)) {
                throw new IllegalArgumentException("unknown key '" + k + "'");
            }
        }
        String name = str(t.get("name"));
        if (name == null || !TOOL_NAME.matcher(name).matches()) throw new IllegalArgumentException("bad name");
        if (already.stream().anyMatch(a -> a.name().equals(name))) throw new IllegalArgumentException("duplicate name " + name);
        String effect = str(t.get("effect"));
        if (effect == null || !EFFECTS.contains(effect)) {
            throw new IllegalArgumentException(name + ": effect must be read or display (got " + effect + ")");
        }
        String desc = str(t.get("description"));
        if (desc == null || desc.isBlank() || desc.length() > MAX_DESCRIPTION) {
            throw new IllegalArgumentException(name + ": description must be 1.." + MAX_DESCRIPTION + " chars");
        }
        return new AiToolSpec(name, desc.strip(), effect, params(name, t.get("parameters")));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> params(String tool, Object p) {
        Map<String, Object> props = new LinkedHashMap<>();
        List<String> required = new ArrayList<>();
        if (p != null) {
            if (!(p instanceof Map<?, ?> m)) throw new IllegalArgumentException(tool + ": parameters must be an object");
            for (Object k : m.keySet()) {
                if (!List.of("type", "properties", "required").contains(String.valueOf(k))) {
                    throw new IllegalArgumentException(tool + ": parameters." + k + " is not allowed");
                }
            }
            if (m.get("type") != null && !"object".equals(m.get("type"))) throw new IllegalArgumentException(tool + ": parameters.type must be object");
            Object pr = m.get("properties");
            if (pr != null) {
                if (!(pr instanceof Map<?, ?> pm)) throw new IllegalArgumentException(tool + ": properties must be an object");
                if (pm.size() > MAX_PARAMS) throw new IllegalArgumentException(tool + ": more than " + MAX_PARAMS + " parameters");
                for (Map.Entry<?, ?> e : pm.entrySet()) {
                    String key = String.valueOf(e.getKey());
                    if (!PARAM_NAME.matcher(key).matches()) throw new IllegalArgumentException(tool + ": bad parameter name '" + key + "'");
                    if (!(e.getValue() instanceof Map<?, ?> spec)) throw new IllegalArgumentException(tool + "." + key + ": must be an object");
                    props.put(key, oneParam(tool + "." + key, (Map<String, Object>) spec));
                }
            }
            Object req = m.get("required");
            if (req != null) {
                if (!(req instanceof List<?> rl)) throw new IllegalArgumentException(tool + ": required must be an array");
                for (Object r : rl) {
                    if (!(r instanceof String rs) || !props.containsKey(rs)) throw new IllegalArgumentException(tool + ": required names an unknown parameter");
                    if (!required.contains(rs)) required.add(rs);
                }
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("type", "object");
        out.put("properties", props);
        out.put("required", required);
        return out;
    }

    private static Map<String, Object> oneParam(String where, Map<String, Object> s) {
        String type = str(s.get("type"));
        List<String> allowed = switch (type == null ? "" : type) {
            case "number", "integer" -> List.of("type", "minimum", "maximum", "description");
            case "string" -> s.containsKey("enum") ? List.of("type", "enum", "description") : List.of("type", "maxLength", "description");
            default -> throw new IllegalArgumentException(where + ": type must be number, integer or string");
        };
        for (String k : s.keySet()) if (!allowed.contains(k)) throw new IllegalArgumentException(where + ": '" + k + "' is not allowed");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("type", type);
        switch (type) {
            case "number", "integer" -> {
                double min = finite(where, "minimum", s.get("minimum"));
                double max = finite(where, "maximum", s.get("maximum"));
                if (min > max) throw new IllegalArgumentException(where + ": minimum > maximum");
                if (type.equals("integer") && (min != Math.rint(min) || max != Math.rint(max))) {
                    throw new IllegalArgumentException(where + ": integer bounds must be whole numbers");
                }
                out.put("minimum", s.get("minimum"));
                out.put("maximum", s.get("maximum"));
            }
            default -> {
                if (s.containsKey("enum")) {
                    if (!(s.get("enum") instanceof List<?> vals) || vals.isEmpty() || vals.size() > MAX_ENUM_VALUES) {
                        throw new IllegalArgumentException(where + ": enum must have 1.." + MAX_ENUM_VALUES + " values");
                    }
                    List<String> clean = new ArrayList<>();
                    for (Object v : vals) {
                        if (!(v instanceof String vs) || vs.isBlank() || vs.length() > MAX_ENUM_VALUE_LENGTH || clean.contains(vs)) {
                            throw new IllegalArgumentException(where + ": bad enum value");
                        }
                        clean.add(vs);
                    }
                    out.put("enum", clean);
                } else {
                    Object ml = s.get("maxLength");
                    if (!(ml instanceof Integer n) || n < 1 || n > MAX_STRING_LENGTH) {
                        throw new IllegalArgumentException(where + ": string needs maxLength 1.." + MAX_STRING_LENGTH);
                    }
                    out.put("maxLength", n);
                }
            }
        }
        String d = str(s.get("description"));
        if (d != null) {
            if (d.length() > MAX_PARAM_DESCRIPTION) throw new IllegalArgumentException(where + ": description too long");
            out.put("description", d.strip());
        }
        return out;
    }

    private static double finite(String where, String key, Object v) {
        if (!(v instanceof Number n) || !Double.isFinite(n.doubleValue())) {
            throw new IllegalArgumentException(where + ": " + key + " must be a finite number");
        }
        return n.doubleValue();
    }

    private static String str(Object o) {
        return o instanceof String s ? s : null;
    }
}

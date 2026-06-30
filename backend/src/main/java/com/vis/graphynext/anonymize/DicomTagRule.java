/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.anonymize;

import java.util.HashMap;
import java.util.Map;

/** タグごとの匿名化ルール（PS3.15 Table E.1-1 の 1 行。GRAPHY DicomTagRule 移植）。 */
public class DicomTagRule {

    /** PS3.15 Table E.1-1a のアクション。 */
    public enum Action {
        X("Remove"), Z("Zero Length"), D("Dummy"), K("Keep"), C("Clean"), U("Unique UID");

        private final String label;

        Action(String label) {
            this.label = label;
        }

        public String getLabel() {
            return label;
        }
    }

    private final int tag;
    private final String name;
    private final Action defaultAction;
    private final Map<AnonymizeConfig.Option, Action> optionActions = new HashMap<>();

    public DicomTagRule(int tag, String name, Action defaultAction) {
        this.tag = tag;
        this.name = name;
        this.defaultAction = defaultAction;
    }

    public void addOptionAction(AnonymizeConfig.Option opt, Action act) {
        optionActions.put(opt, act);
    }

    public Map<AnonymizeConfig.Option, Action> getOptionActions() {
        return optionActions;
    }

    public int getTag() {
        return tag;
    }

    public String getName() {
        return name;
    }

    public Action getDefaultAction() {
        return defaultAction;
    }
}

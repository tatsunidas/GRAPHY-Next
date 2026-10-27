/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.album;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * アルバム（スタディの手動分類）の永続化。
 *
 * <p>入力は<b>全件通るか全件拒否か</b>（不正な UID が 1 つでもあれば何も入れない）。
 * スタディの存在は確かめない（{@link AlbumStudy}）。アルバムの削除・所属の取り外しは、
 * アルバム側の行だけを消し、スタディ本体（画像・索引）には触らない。
 */
@Service
public class AlbumService {

    static final int NAME_MAX = 100;
    static final int UID_MAX = 64;
    /** 1 回の追加・取り外しで受ける UID の数。 */
    static final int UIDS_MAX = 1000;

    private static final Pattern UID = Pattern.compile("[0-9.]{1," + UID_MAX + "}");

    private final AlbumRepository albums;
    private final AlbumStudyRepository members;

    public AlbumService(AlbumRepository albums, AlbumStudyRepository members) {
        this.albums = albums;
        this.members = members;
    }

    @Transactional(readOnly = true)
    public List<AlbumDto> list() {
        Map<Long, Long> counts = new HashMap<>();
        for (Object[] row : members.countByAlbum()) {
            counts.put((Long) row[0], (Long) row[1]);
        }
        return albums.findAll().stream()
                .sorted(Comparator.comparing(Album::getName).thenComparing(Album::getId))
                .map(a -> toDto(a, counts.getOrDefault(a.getId(), 0L)))
                .toList();
    }

    @Transactional
    public AlbumDto create(String name) {
        String n = requireName(name);
        if (albums.existsByName(n)) {
            throw duplicate();
        }
        try {
            return toDto(albums.saveAndFlush(new Album(n)), 0);
        } catch (DataIntegrityViolationException e) {
            throw duplicate(); // 同時に同じ名前が作られた
        }
    }

    @Transactional
    public AlbumDto rename(Long id, String name) {
        String n = requireName(name);
        Album a = require(id);
        if (albums.existsByNameAndIdNot(n, id)) {
            throw duplicate();
        }
        a.setName(n);
        try {
            albums.saveAndFlush(a);
        } catch (DataIntegrityViolationException e) {
            throw duplicate();
        }
        return toDto(a, members.countByIdAlbumId(id));
    }

    /** アルバムと所属の記録だけを消す。スタディ本体には触らない。 */
    @Transactional
    public void delete(Long id) {
        Album a = require(id);
        members.deleteAllMembers(id);
        albums.delete(a);
    }

    @Transactional(readOnly = true)
    public List<String> studies(Long id) {
        require(id);
        return members.findUids(id);
    }

    @Transactional
    public AlbumRequests.AddResult add(Long id, List<String> studyUids) {
        require(id);
        Set<String> uids = validUids(studyUids);
        Set<String> already = new LinkedHashSet<>(members.findExisting(id, uids));
        List<AlbumStudy> fresh = new ArrayList<>();
        // 追加順を保つため、同じ要求の中でも 1 マイクロ秒ずつずらす（H2 の TIMESTAMP の精度）。
        Instant base = Instant.now();
        int i = 0;
        for (String uid : uids) {
            if (!already.contains(uid)) {
                fresh.add(new AlbumStudy(id, uid, base.plusNanos(1000L * i++)));
            }
        }
        members.saveAll(fresh);
        return new AlbumRequests.AddResult(fresh.size(), already.size());
    }

    /** @return 実際に外れた件数（元から入っていないものは数えない） */
    @Transactional
    public int remove(Long id, List<String> studyUids) {
        require(id);
        return members.deleteMembers(id, validUids(studyUids));
    }

    private Album require(Long id) {
        return albums.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "アルバムが見つかりません"));
    }

    private static ResponseStatusException duplicate() {
        return new ResponseStatusException(HttpStatus.CONFLICT, "同じ名前のアルバムがあります");
    }

    private static String requireName(String name) {
        String n = name == null ? "" : name.trim();
        if (n.isEmpty() || n.length() > NAME_MAX) {
            throw new IllegalArgumentException("アルバムの名前は 1〜" + NAME_MAX + " 字で指定してください");
        }
        return n;
    }

    /** UID を検査して重複を除く。1 つでも不正なら全体を拒否する。 */
    private static Set<String> validUids(List<String> studyUids) {
        if (studyUids == null || studyUids.isEmpty()) {
            throw new IllegalArgumentException("studyUids を指定してください");
        }
        if (studyUids.size() > UIDS_MAX) {
            throw new IllegalArgumentException("一度に指定できるのは " + UIDS_MAX + " 件までです");
        }
        Set<String> out = new LinkedHashSet<>();
        for (String uid : studyUids) {
            if (uid == null || !UID.matcher(uid).matches()) {
                throw new IllegalArgumentException("StudyInstanceUID の形式が正しくありません");
            }
            out.add(uid);
        }
        return out;
    }

    private static AlbumDto toDto(Album a, long count) {
        return new AlbumDto(a.getId(), a.getName(), a.getCreatedAt(), count);
    }
}

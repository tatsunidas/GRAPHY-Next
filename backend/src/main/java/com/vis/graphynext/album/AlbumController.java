/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
package com.vis.graphynext.album;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * アルバム（スタディの手動分類）の REST。
 *
 * <ul>
 *   <li>{@code GET /api/albums} … 一覧（名前順・所属数つき）</li>
 *   <li>{@code POST /api/albums} … 作成。名前が不正は 400、重複は 409</li>
 *   <li>{@code PUT /api/albums/{id}} … 名前の変更</li>
 *   <li>{@code DELETE /api/albums/{id}} … アルバムだけを消す（スタディ本体は消さない）</li>
 *   <li>{@code GET /api/albums/{id}/studies} … 所属の StudyInstanceUID（追加順）</li>
 *   <li>{@code POST /api/albums/{id}/studies} … 追加（重複は無視）</li>
 *   <li>{@code POST /api/albums/{id}/studies/remove} … 取り外し（宙ぶらりんの掃除にも使う）</li>
 * </ul>
 */
@RestController
@RequestMapping("/api/albums")
public class AlbumController {

    private final AlbumService service;

    public AlbumController(AlbumService service) {
        this.service = service;
    }

    @GetMapping
    public List<AlbumDto> list() {
        return service.list();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public AlbumDto create(@RequestBody AlbumRequests.NameRequest req) {
        return service.create(req.name());
    }

    @PutMapping("/{id}")
    public AlbumDto rename(@PathVariable Long id, @RequestBody AlbumRequests.NameRequest req) {
        return service.rename(id, req.name());
    }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable Long id) {
        service.delete(id);
    }

    @GetMapping("/{id}/studies")
    public List<String> studies(@PathVariable Long id) {
        return service.studies(id);
    }

    @PostMapping("/{id}/studies")
    public AlbumRequests.AddResult add(@PathVariable Long id, @RequestBody AlbumRequests.StudyUidsRequest req) {
        return service.add(id, req.studyUids());
    }

    @PostMapping("/{id}/studies/remove")
    public Map<String, Integer> remove(@PathVariable Long id, @RequestBody AlbumRequests.StudyUidsRequest req) {
        return Map.of("removed", service.remove(id, req.studyUids()));
    }
}

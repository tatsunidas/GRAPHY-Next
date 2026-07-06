# GRAPHY-Next ビルド/起動オーケストレーション
#
# 主要ターゲット:
#   make install        … frontend / desktop の依存をインストール
#   make build          … frontend → backend(jar, UI同梱) → desktop 同梱 まで一括
#   make dev-web        … Web モード開発起動（backend[web] + Vite dev）
#   make dev-desktop    … デスクトップモード開発起動（Electron + backend[standalone]）
#   make run-web        … ビルド済み web jar を単体起動（http://localhost:8080）
#   make test           … backend テスト
#   make clean          … 生成物を削除

SHELL := /bin/bash
ROOT  := $(CURDIR)
BACKEND_JAR := backend/target/graphy-next-backend.jar
MVN ?= mvn
# JRE 同梱用。CI では setup-java が JAVA_HOME を設定（?= は環境値を優先）。
JAVA_HOME ?= /usr/lib/jvm/temurin-21-jdk-amd64

.PHONY: install install-frontend install-desktop \
        build build-frontend build-backend build-desktop \
        dev-web dev-desktop run-web test clean ffmpeg dcm4che-tools

install: install-frontend install-desktop

install-frontend:
	cd frontend && npm install

install-desktop:
	cd desktop && npm install

# --- frontend 単体ビルド（任意。backend ビルドが内部で実行するので通常は不要） ---
build-frontend:
	cd frontend && npm run build

# --- backend ---
# frontend のビルドと static 同梱は pom(frontend-maven-plugin)が行うため、
# ここは mvn package を呼ぶだけ。これだけで UI 同梱 jar が完成する。
build-backend:
	cd backend && $(MVN) -q clean package

# --- desktop (backend が生成した frontend/dist と jar、Java21 JRE を同梱) ---
build-desktop: build-backend
	rm -rf desktop/renderer desktop/resources/backend desktop/resources/jre
	mkdir -p desktop/renderer desktop/resources/backend
	cp -r frontend/dist/. desktop/renderer/
	cp $(BACKEND_JAR) desktop/resources/backend/graphy-next-backend.jar
	# Release 同梱JRE の下限を Java 21 に強制（21未満の JDK で誤って同梱するのを弾く。
	# backend jar は release=21 でコンパイルされ 21未満の JRE では起動しないため、ここで先に検出する）。
	@MAJOR=`"$(JAVA_HOME)/bin/java" -version 2>&1 | sed -n 's/.* version "\([0-9][0-9]*\).*/\1/p' | head -1`; \
		if [ -z "$$MAJOR" ] || [ "$$MAJOR" -lt 21 ]; then \
			echo "ERROR: Release の同梱JRE は Java 21 以上が必要です（JAVA_HOME=$(JAVA_HOME)）"; \
			"$(JAVA_HOME)/bin/java" -version 2>&1 | head -1; \
			exit 1; \
		fi
	# このOS向けの最小化 Java21 ランタイムを同梱（システムJava不要にする）
	"$(JAVA_HOME)/bin/jlink" --add-modules ALL-MODULE-PATH --strip-debug --no-man-pages --no-header-files --output desktop/resources/jre

build: build-desktop

# --- 動画トランスコード用 ffmpeg を OS 別に取得し desktop/resources/ffmpeg へ配置（リリース同梱用） ---
# 例: make ffmpeg                      … 全 OS/アーキ
#     make ffmpeg FFMPEG_TARGETS=linux-x64  … 指定ターゲットのみ（その OS の installer 用）
FFMPEG_TARGETS ?=
ffmpeg:
	bash scripts/fetch-ffmpeg.sh $(FFMPEG_TARGETS)

# --- QR(C-FIND/C-MOVE/C-GET) 用 dcm4che CLI ツールを desktop/resources/dcm4che へ配置（リリース同梱用） ---
# Java 製ツールのため OS/アーキ別配布は不要（全 OS 共通の 1 セット）。
dcm4che-tools:
	bash scripts/fetch-dcm4che-tools.sh

# --- 開発起動 ---
dev-web:
	bash scripts/dev-web.sh

dev-desktop:
	bash scripts/dev-desktop.sh

# --- 本番 web jar 単体起動 ---
run-web: build-backend
	java -jar $(BACKEND_JAR) --spring.profiles.active=web

test:
	cd backend && $(MVN) -q test

clean:
	cd backend && $(MVN) -q clean || true
	rm -rf backend/src/main/resources/static
	rm -rf frontend/dist desktop/renderer desktop/resources/backend desktop/resources/jre
	rm -rf frontend/node_modules desktop/node_modules

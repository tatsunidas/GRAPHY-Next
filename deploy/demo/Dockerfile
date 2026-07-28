# GRAPHY-Next backend（web,demo プロファイル）のデモ公開用イメージ。
# frontend のビルドは pom.xml の frontend-maven-plugin が内部で行うため、
# ここでは Maven ビルド一発で UI 同梱 jar が出来上がる。
#
# ビルド: docker build -f deploy/demo/Dockerfile -t graphy-next-demo:latest ../..
# （ビルドコンテキストはリポジトリルート）

FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY backend/pom.xml backend/pom.xml
COPY backend/src backend/src
COPY frontend frontend
RUN --mount=type=cache,target=/root/.m2 \
    mvn -f backend/pom.xml -B clean package -DskipTests

FROM eclipse-temurin:21-jre-jammy
RUN useradd --system --create-home --uid 10001 graphy
WORKDIR /app
COPY --from=build /src/backend/target/graphy-next-backend.jar app.jar
# /app/subscribers は「お知らせメール登録者だけ」を置く別DB用のマウントポイント。
# ここでディレクトリを作って graphy に chown しておかないと、Docker が作るマウント先が
# root 所有になり、read_only なコンテナ内のアプリ（uid 10001）がDBを作れない。
# /app/data と分けている理由は MailingListSubscriberRepository のクラスコメントを参照
# （毎晩の reset-demo.sh が /app/data を丸ごと巻き戻すため、同居させると登録者が毎晩消える）。
RUN mkdir -p /app/data /app/plugins /app/subscribers && chown -R graphy:graphy /app
USER graphy
EXPOSE 8090
ENTRYPOINT ["java", "-jar", "/app/app.jar", \
    "--spring.profiles.active=web,demo", \
    "--server.port=8090"]

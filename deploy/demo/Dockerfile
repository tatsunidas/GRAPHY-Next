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
RUN mkdir -p /app/data /app/plugins && chown -R graphy:graphy /app
USER graphy
EXPOSE 8090
ENTRYPOINT ["java", "-jar", "/app/app.jar", \
    "--spring.profiles.active=web,demo", \
    "--server.port=8090"]

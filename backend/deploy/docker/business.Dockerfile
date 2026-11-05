# =============================================================================
# business-service（Spring Boot：登录 / 挂号 / 医生 / 床位 / 用户）
# 构建上下文：backend/    Dockerfile：deploy/docker/business.Dockerfile
# 本地验证：docker build -f backend/deploy/docker/business.Dockerfile backend
#
# 硬依赖：MySQL（云托管必须用独立 CDB / 云数据库，容器内不得跑 mysqld——磁盘是临时的）
# =============================================================================
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /src

# 先只拷 pom 下依赖，利用 Docker 层缓存（改代码不会重拉全量依赖）
COPY business-service/pom.xml ./pom.xml
# ⚠️ 不加 `|| true`（2026-11-04）：依赖预取失败必须在构建期就暴露。
#    加了 `|| true` 会把错误推到下一步 `mvn package`，日志指向的编译阶段与真实原因错位。
#    构建期需要出网访问 Maven 中央仓库（本项目无私有仓库）。
RUN mvn -B -q -DskipTests dependency:go-offline

COPY business-service/src ./src
RUN mvn -B -q -DskipTests package

FROM eclipse-temurin:17-jre
# =============================================================================
# ⚠️ 云托管控制台必须注入（缺一项 = 容器**启动即退出**，不是功能降级）：
#   MYSQL_URL / MYSQL_USER / MYSQL_PASSWORD  —— Flyway 启动即连，连不上直接失败
#   PHONE_KEY_BASE64                         —— PhoneCrypto 构造器对空值抛异常
#   APP_ATTACHMENT_SIGN_SECRET               —— AttachmentStorage 空值抛异常（多副本必须同值）
#   AI_SERVICE_TOKEN                         —— 必须与 ai-service **同值**，否则调 AI 全 401
# 缺失只降级不阻断启动：WECHAT_MINIPROGRAM_APP_ID / APP_SECRET（登录 503）。
# 可选：APP_RESOURCES_PUBLIC_BASE_URL（资源清单绝对 URL，留空时行为见 application.yml 注释）。
# =============================================================================
ENV TZ=Asia/Shanghai \
    SPRING_PROFILES_ACTIVE=prod \
    SERVER_PORT=8088 \
    APP_RESOURCES_DIR=/app/resources \
    APP_UPLOAD_DIR=/app/run/uploads \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+UseSerialGC"

WORKDIR /app
COPY --from=build /src/target/*.jar ./app.jar
# 资源库（V14）：二进制由 business 的 /api/v1/resources/{key} 直出
COPY deploy/resources ./resources
RUN mkdir -p /app/run/uploads

EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD bash -c "exec 3<>/dev/tcp/127.0.0.1/8088 && printf 'GET /actuator/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3 && cat <&3 | grep -q '\"UP\"'"

ENTRYPOINT ["java", "-jar", "/app/app.jar"]

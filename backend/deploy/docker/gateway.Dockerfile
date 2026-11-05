# =============================================================================
# edge-gateway（统一网关，小程序唯一出口）
# 构建上下文：backend/    Dockerfile：deploy/docker/gateway.Dockerfile
# 本地验证：docker build -f backend/deploy/docker/gateway.Dockerfile backend
#
# 为什么 Dockerfile 放在 deploy/docker 而不是服务目录：
#   网关需要把 deploy/resources 打进镜像（小程序静态资源由网关直出），
#   而 `COPY` 不能跨出构建上下文 → 上下文必须是 backend/。
# =============================================================================
FROM python:3.12-slim

ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai \
    PIP_INDEX_URL=${PIP_INDEX_URL}

WORKDIR /app

COPY edge-gateway/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY edge-gateway/app ./app
# 静态资源（图标/图片）由网关 /assets 直出，必须进镜像
COPY deploy/resources ./assets

# ⚠️ GW_PROXY_TIMEOUT_SECONDS **只可保持 220，不得下调**：
#    CARE_PLAN 上游预算 60s + business 等待 75s + 余量，下调会把"能成功"的请求提前判超时。
ENV GW_PORT=8080 \
    GW_ASSETS_DIR=/app/assets \
    GW_PROXY_TIMEOUT_SECONDS=220 \
    GW_PROBE_TIMEOUT_SECONDS=2 \
    GW_LOG_LEVEL=INFO \
    GW_CONFIG_PATH=""

EXPOSE 8080
# ⚠️ 云托管「服务设置」里把容器端口改为 8080（平台默认 80），否则容器 Running 但流量进不来。
# ⚠️ 只给本服务开公网；business-service / ai-service 必须**关闭公网访问**，
#    否则可绕过统一入口的限流、匿名白名单与鉴权边界。

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import sys,urllib.request; r=urllib.request.urlopen('http://127.0.0.1:8080/api/gw/health', timeout=4); sys.exit(0 if r.status in (200,503) else 1)"

# 单 worker：网关有进程内限流器/熔断状态，多 worker 会让阈值翻倍（部署侧不要覆盖 workers 数）
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]

# =============================================================================
# ai-service（FastAPI：TRIAGE / CHAT / CARE_PLAN / INTERPRET / ASR / TTS）
# 构建上下文：backend/    Dockerfile：deploy/docker/ai.Dockerfile
# 本地验证：docker build -f backend/deploy/docker/ai.Dockerfile backend
#
# 三步走（B2）：Ollama（内网穿透，可空）→ DeepSeek（公网 API）→ business 规则引擎兜底。
# 云上通常连不到本机 Ollama，靠 AI_DEEPSEEK_API_KEY 提供第二级；key 只走环境变量，不进镜像。
# =============================================================================
FROM python:3.12-slim

ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai \
    PIP_INDEX_URL=${PIP_INDEX_URL}

WORKDIR /app

COPY ai-service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY ai-service/app ./app
# 科室白名单 + 院内知识库（默认路径 = /app/config/*.json）
COPY ai-service/config ./config
RUN mkdir -p /app/runtime

# 单实例：任务状态是进程内 + tasks.json（磁盘），多副本会各自持有不同任务表。
# 扩到 >1 副本前必须先按计划 B1.5 把任务状态外置（Redis/CDB），否则任务会"丢"。
#
# ⚠️ 云托管控制台必须注入（缺一项 = 容器**启动即退出**）：
#   AI_SERVICE_TOKEN   ≥32 字符；static 模式缺失即 RuntimeError（app/security.py）
#                      —— 必须与 business 的 AI_SERVICE_TOKEN 同值，否则互相 401
# ⚠️ 不配就会静默降级/回错地址（不阻断启动，但功能不可用）：
#   AI_DEEPSEEK_API_KEY  —— 不配 = 第二级直接跳过；云上连不到 Ollama，AI 只剩 business 规则兜底
#   AI_TTS_PUBLIC_BASE   —— 必须改成 https://<网关域名>/api/gw，配合 AI_TTS_PUBLIC_PATH=/tts/audio
#                           不配则返回 http://127.0.0.1:8001/...（前端 100% 播不出）
#   AI_OLLAMA_URL        —— 本镜像默认 127.0.0.1:11434 在云上**必然连不上**（容器内无 Ollama）；
#                           要么填本地穿透公网地址，要么留默认让第一级快速失败后走 DeepSeek
# ⚠️ ASR 在云上是**确定降级**：本镜像只装 requirements.txt（不含 requirements-asr.txt），
#   FunASR 权重也未打包；且 AI_ASR_AUDIO_DIR 需要与 business 共享目录，两个容器不同盘。
#   要恢复 ASR 必须先做对象存储传递（计划 B1.5），不要把它当配置问题排查。
ENV AI_PORT=8001 \
    AI_LOG_LEVEL=INFO \
    AI_STORE_PATH=/app/runtime/tasks.json \
    AI_PROVIDER_ORDER=ollama,deepseek \
    AI_OLLAMA_URL=http://127.0.0.1:11434 \
    AI_OLLAMA_FIRST_TOKEN_TIMEOUT=8 \
    AI_BREAKER_FAILURES=3 \
    AI_BREAKER_COOLDOWN_SECONDS=60

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import sys,urllib.request; r=urllib.request.urlopen('http://127.0.0.1:8001/internal/health/live', timeout=4); sys.exit(0 if r.status==200 else 1)"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]

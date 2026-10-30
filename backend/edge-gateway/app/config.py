"""edge-gateway 配置：backend/deploy/config.json 为唯一配置点，环境变量可覆盖。

配置优先级：环境变量（GW_*） > deploy/config.json > 内置默认值。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

APP_VERSION = "0.1.0-m3"

_SERVICE_DIR = Path(__file__).resolve().parent.parent
_REPO_ROOT = _SERVICE_DIR.parent.parent  # backend/edge-gateway → 仓库根
_DEFAULT_CONFIG_PATH = _SERVICE_DIR.parent / "deploy" / "config.json"


def _env(name: str) -> Optional[str]:
    value = os.environ.get(name)
    return value if value not in (None, "") else None


@dataclass
class GateSettings:
    # 对外统一入口端口：内网穿透映射与小程序合法域名都指向这里（8080）。
    # 上游 business(8088) / ai(8001) 只在内网，不由穿透暴露。
    port: int = 8080
    business_url: str = "http://127.0.0.1:8088"
    ai_url: str = "http://127.0.0.1:8001"
    # Ollama 本地模型服务：care-plans / consultations 的 AI 生成依赖它常驻。
    # /api/gw/health 必须如实上报（此前只报 java/python，运维看不出真实可用性，见 §5.4）。
    ollama_url: str = "http://127.0.0.1:11434"
    ollama_probe_path: str = "/api/tags"
    proxy_timeout_seconds: float = 220.0
    probe_timeout_seconds: float = 2.0
    connect_timeout_seconds: float = 5.0
    log_level: str = "INFO"
    # ---- 限流（M4 硬化前瞻；默认关，deploy 显式开启）----
    rate_limit_enabled: bool = False
    rate_limit_per_minute: int = 300
    rate_limit_window_seconds: int = 60
    # ---- 受控 CORS（本地调试台跨域调用；生产应置 false）----
    cors_enabled: bool = True
    # 允许的跨域来源（安全默认：空 = 不开放任何来源，绝不回落通配 "*"）。
    # 配置方式：config.json "cors": { "enabled": true, "allowOrigins": ["https://a.example"] }
    #          或环境变量 GW_CORS_ALLOW_ORIGINS（逗号分隔）。
    cors_allow_origins: list[str] = field(default_factory=list)
    # ---- 静态素材公开通道（/api/gw/assets；前端适配：素材经后端传递，docs/v4/09 §4.2）----
    # 默认 <仓库根>/backend/deploy/resources；config.json.assets.dir 或 GW_ASSETS_DIR 可覆盖。
    assets_dir: Path = field(default_factory=lambda: _SERVICE_DIR.parent / "deploy" / "resources")
    # ---- legacy 兼容登录（POST /api/user/login 的 dev 替身）----
    # 该条目用派生的 dev code 换取会话，属联调替身（x-migration 声明生产不得使用）。
    # 安全默认 = False：未显式开启即 404，仅本地/联调环境在 deploy/config.json 显式置
    # "compat": { "legacyLoginEnabled": true }，或用 GW_LEGACY_LOGIN_ENABLED 覆盖。
    compat_legacy_login_enabled: bool = False
    # ---- 投屏桥接（N14/N15/N16）----
    # cast_bridge_enabled：SSDP/DLNA 设备发现桥接是否已接入（env GW_CAST_BRIDGE_ENABLED）。
    # 未接入时 /api/gw/cast/devices 返回 503（前端显空态，不伪造设备），默认关。
    cast_bridge_enabled: bool = False
    # cast_devices：dev 档的进程内设备注册表（env GW_CAST_DEVICES，JSON 数组，
    # 如 [{"deviceId":"tv-1","name":"候诊屏","ip":"10.0.0.11"}]），默认空数组；
    # 生产应由桥接真实发现填充，配置项仅用于联调/演示，不冒充发现结果。
    cast_devices: list[dict] = field(default_factory=list)
    config_path: Path = field(default_factory=lambda: _DEFAULT_CONFIG_PATH)

    @classmethod
    def load(cls) -> "GateSettings":
        settings = cls()
        path = Path(_env("GW_CONFIG_PATH") or settings.config_path)
        if path.exists():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                ports = raw.get("ports") or {}
                upstreams = raw.get("upstreams") or {}
                if ports.get("gateway"):
                    settings.port = int(ports["gateway"])
                if upstreams.get("business"):
                    settings.business_url = str(upstreams["business"])
                if upstreams.get("ai"):
                    settings.ai_url = str(upstreams["ai"])
                if upstreams.get("ollama"):
                    settings.ollama_url = str(upstreams["ollama"])
                if raw.get("proxyTimeoutSeconds"):
                    settings.proxy_timeout_seconds = float(raw["proxyTimeoutSeconds"])
                if raw.get("probeTimeoutSeconds"):
                    settings.probe_timeout_seconds = float(raw["probeTimeoutSeconds"])
                # 限流（config.json 可配；默认仍关，须显式 enabled=true）
                rate_limit = raw.get("rateLimit") or {}
                if rate_limit.get("enabled") is not None:
                    settings.rate_limit_enabled = bool(rate_limit["enabled"])
                if rate_limit.get("perMinute"):
                    settings.rate_limit_per_minute = int(rate_limit["perMinute"])
                if rate_limit.get("windowSeconds"):
                    settings.rate_limit_window_seconds = int(rate_limit["windowSeconds"])
                # 受控 CORS
                cors = raw.get("cors") or {}
                if cors.get("enabled") is not None:
                    settings.cors_enabled = bool(cors["enabled"])
                origins = cors.get("allowOrigins")
                if isinstance(origins, list):
                    settings.cors_allow_origins = [str(o).strip() for o in origins if str(o).strip()]
                # 素材目录（相对路径以仓库根为基准；绝对路径原样采用）
                assets = raw.get("assets") or {}
                if assets.get("dir"):
                    assets_path = Path(str(assets["dir"]))
                    settings.assets_dir = assets_path if assets_path.is_absolute() else (_REPO_ROOT / assets_path)
                # legacy 兼容登录开关（缺省 false = 404；仅联调环境显式置 true）
                compat_raw = raw.get("compat") or {}
                if compat_raw.get("legacyLoginEnabled") is not None:
                    settings.compat_legacy_login_enabled = bool(compat_raw["legacyLoginEnabled"])
                settings.config_path = path
            except (OSError, ValueError, TypeError):
                # 配置损坏不静默：告警后回落默认值（服务仍可启动，README 已注明）
                import logging

                logging.getLogger("edge-gateway.config").warning("config.json 读取失败，使用默认配置：%s", path)
        # 环境变量覆盖
        if _env("GW_PORT"):
            settings.port = int(_env("GW_PORT"))
        if _env("GW_BUSINESS_URL"):
            settings.business_url = _env("GW_BUSINESS_URL")  # type: ignore[assignment]
        if _env("GW_AI_URL"):
            settings.ai_url = _env("GW_AI_URL")  # type: ignore[assignment]
        if _env("GW_OLLAMA_URL"):
            settings.ollama_url = _env("GW_OLLAMA_URL")  # type: ignore[assignment]
        if _env("GW_OLLAMA_PROBE_PATH"):
            settings.ollama_probe_path = _env("GW_OLLAMA_PROBE_PATH")  # type: ignore[assignment]
        if _env("GW_PROXY_TIMEOUT_SECONDS"):
            settings.proxy_timeout_seconds = float(_env("GW_PROXY_TIMEOUT_SECONDS"))
        if _env("GW_LOG_LEVEL"):
            settings.log_level = _env("GW_LOG_LEVEL")  # type: ignore[assignment]
        if _env("GW_RATE_LIMIT_ENABLED"):
            settings.rate_limit_enabled = _env("GW_RATE_LIMIT_ENABLED").lower() in ("1", "true", "yes", "on")  # type: ignore[union-attr]
        if _env("GW_RATE_LIMIT_PER_MINUTE"):
            settings.rate_limit_per_minute = int(_env("GW_RATE_LIMIT_PER_MINUTE"))  # type: ignore[arg-type]
        if _env("GW_RATE_LIMIT_WINDOW_SECONDS"):
            settings.rate_limit_window_seconds = int(_env("GW_RATE_LIMIT_WINDOW_SECONDS"))  # type: ignore[arg-type]
        if _env("GW_CORS_ENABLED"):
            settings.cors_enabled = _env("GW_CORS_ENABLED").lower() in ("1", "true", "yes", "on")
        if _env("GW_CORS_ALLOW_ORIGINS"):
            settings.cors_allow_origins = [
                o.strip() for o in _env("GW_CORS_ALLOW_ORIGINS").split(",") if o.strip()  # type: ignore[union-attr]
            ]
        if _env("GW_ASSETS_DIR"):
            assets_path = Path(_env("GW_ASSETS_DIR"))  # type: ignore[arg-type]
            settings.assets_dir = assets_path if assets_path.is_absolute() else (_REPO_ROOT / assets_path)
        if _env("GW_LEGACY_LOGIN_ENABLED"):
            settings.compat_legacy_login_enabled = _env("GW_LEGACY_LOGIN_ENABLED").lower() in ("1", "true", "yes", "on")  # type: ignore[union-attr]
        # 投屏桥接（N14/N15/N16）：GW_CAST_BRIDGE_ENABLED / GW_CAST_DEVICES（JSON 数组）
        if _env("GW_CAST_BRIDGE_ENABLED"):
            settings.cast_bridge_enabled = _env("GW_CAST_BRIDGE_ENABLED").lower() in ("1", "true", "yes", "on")  # type: ignore[union-attr]
        if _env("GW_CAST_DEVICES"):
            try:
                parsed = json.loads(_env("GW_CAST_DEVICES"))  # type: ignore[arg-type]
                if isinstance(parsed, list):
                    settings.cast_devices = parsed
                else:
                    raise ValueError("GW_CAST_DEVICES 不是 JSON 数组")
            except (ValueError, TypeError):
                # 配置损坏不静默：告警后保留默认空注册表（不伪造设备）
                import logging

                logging.getLogger("edge-gateway.config").warning("GW_CAST_DEVICES 解析失败，投屏设备注册表使用默认空数组")
        return settings

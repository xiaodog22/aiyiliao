"""医疗安全红线主清单加载模块（2026-11-21 治理合并，唯一事实源）。

红线文案本体在 config/medical-redlines.json；本模块只做加载与导出，
供执行器（careplan/triage 的 limitations 等独立文案）引用，避免散写副本。
chat/interpret 的场景化红线句式内嵌于调优后的 system prompt，由门禁
（tools/check-knowledge-base.py）按主清单 executorVerbatimSentences 逐字校验。
"""

from __future__ import annotations

import json
from pathlib import Path

_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "medical-redlines.json"

_data = json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))

REDLINES: dict[str, str] = {r["id"]: r["text"] for r in _data["redlines"]}

_CONSUMERS = _data.get("consumers") or {}

# careplan 输出尾注：业务侧（Java）按 containsString("不构成处方") 做红线断言，
# 文案以主清单为唯一源，改动必须同步 medical-redlines.json。
CAREPLAN_LIMITATIONS: str = _CONSUMERS["careplanLimitations"]
TRIAGE_LIMITATIONS: str = _CONSUMERS["triageLimitations"]
CHAT_FRAGMENT_CONTENT: str = _CONSUMERS["chatFragmentContent"]

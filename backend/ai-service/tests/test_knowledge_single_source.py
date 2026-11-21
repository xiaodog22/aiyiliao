"""单一事实源一致性（2026-11-21 治理合并）。

钉死四条链路，防止回退为双维护：
1. ⑦ triage「本院科室」片段 == ⑧ 白名单 16 科室（顺序一致，来源=⑧）；
2. ⑦ chat「禁忌与红线」片段 == 红线主清单 consumers.chatFragmentContent（逐字）；
3. careplan/triage 执行器的 limitations 文案来自 app/medical_redlines.py（与主清单逐字一致）；
4. ⑪ 科普入库脚本无手抄 ARTICLES，且读同源 data/knowledge-articles.json。

①↔⑧ 科室口径与 ⑦ 生成片段的漂移检查由构建期脚本承担（Node 才能 require ①）：
    node tools/gen-hospital-knowledge.js --check
    node tools/export-knowledge-kb.js --check
"""

from __future__ import annotations

import json
import re
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
KB = SERVICE_DIR / "config" / "hospital-knowledge.json"
WHITELIST = SERVICE_DIR / "config" / "triage-departments.json"
REDLINES = SERVICE_DIR / "config" / "medical-redlines.json"
ARTICLES_JSON = SERVICE_DIR / "data" / "knowledge-articles.json"
INGEST_SCRIPT = SERVICE_DIR / "scripts" / "ingest_knowledge_kb.py"


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_triage_dept_fragment_equals_whitelist():
    kb = _load(KB)
    wl = _load(WHITELIST)
    names = [d["name"] for d in wl["departments"]]
    frag = next(i for i in kb["scenarios"]["triage"]["knowledge"] if i["topic"] == "本院科室")
    assert frag["departments"] == names, "「本院科室」声明科室必须与 ⑧ 白名单逐一对应"
    assert "、".join(names) in frag["content"], "「本院科室」正文应逐字列出 ⑧ 全部科室名"
    assert f"v{wl['version']}" in frag["source"], "片段 source 应标注 ⑧ 实际版本（生成式描述）"


def test_chat_redline_fragment_from_master():
    kb = _load(KB)
    master = _load(REDLINES)
    expected = master["consumers"]["chatFragmentContent"]
    frag = next(i for i in kb["scenarios"]["chat"]["knowledge"] if i["topic"] == "禁忌与红线")
    assert frag["content"] == expected, "chat 红线片段必须逐字等于主清单（唯一源）"


def test_executor_limitations_reference_master():
    from app.medical_redlines import CAREPLAN_LIMITATIONS, CHAT_FRAGMENT_CONTENT, TRIAGE_LIMITATIONS

    master = _load(REDLINES)
    consumers = master["consumers"]
    assert CAREPLAN_LIMITATIONS == consumers["careplanLimitations"]
    assert TRIAGE_LIMITATIONS == consumers["triageLimitations"]
    assert CHAT_FRAGMENT_CONTENT == consumers["chatFragmentContent"]

    careplan_src = (SERVICE_DIR / "app" / "executors" / "careplan.py").read_text(encoding="utf-8")
    triage_src = (SERVICE_DIR / "app" / "executors" / "triage.py").read_text(encoding="utf-8")
    assert "from ..medical_redlines import" in careplan_src
    assert "from ..medical_redlines import" in triage_src
    # 主清单文案不得再以字面量散写在执行器里（引用模块是唯一入口）
    assert consumers["careplanLimitations"] not in careplan_src
    assert consumers["triageLimitations"] not in triage_src


def test_ingest_script_no_manual_copy():
    src = INGEST_SCRIPT.read_text(encoding="utf-8")
    assert "ARTICLES = [" not in src, "⑪ 不得回退为手抄科普内容"
    assert "knowledge-articles.json" in src
    articles = _load(ARTICLES_JSON)
    assert articles["sourceFile"] == "miniprogram/utils/knowledge-kb.js"
    # 历史漂移样例：入库数据源标题必须采用前端 ③ 口径
    titles = {a["id"]: a["title"] for a in articles["articles"]}
    assert titles["sleep-quality"] == "睡不好？先把这 5 件小事做到位"
    assert titles["bp-daily"] == "高血压的一天怎么过？记住这 5 个时间点"
    assert titles["diabetes-diet"] == "糖尿病吃饭不用称：三个拳头就够了"


def test_embedding_model_consistent_across_ingest_scripts():
    """两套向量库暂不合并，但入库口径统一：默认 embedding 模型必须一致（P2 决策）。"""
    qdrant_src = INGEST_SCRIPT.read_text(encoding="utf-8")
    redis_src = (SERVICE_DIR / "tools" / "rag_redis_seed.py").read_text(encoding="utf-8")
    m1 = re.search(r'--model",\s*default="([^"]+)"', qdrant_src)
    m2 = re.search(r'--model",\s*default="([^"]+)"', redis_src)
    assert m1 and m2, "两个入库脚本都应保留 --model 默认值"
    assert m1.group(1) == m2.group(1), "⑪⑫ 默认 embedding 模型必须一致"
    assert '"embeddingModel"' in qdrant_src and '"embeddingModel"' in redis_src, "入库 payload 必须记录 embedding 模型"

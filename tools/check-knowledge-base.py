"""院内知识库校验（门禁）：schema / 预算 / 科室白名单 / 隐私 / 断言性文案。

用法（在仓库根执行；纯标准库，无需 venv）：
    python tools/check-knowledge-base.py
    python tools/check-knowledge-base.py --json      # 机器可读摘要
退出码：0=全绿；1=有错误（可接 CI / 提交前钩子）。

校验项（对应 2026-10-22 任务约束）：
1. **schema 兼容**：`version` + `scenarios` 必备；`metadata.reviewedBy/reviewedAt/source` 必备；
   场景必须恰好覆盖 triage/chat/careplan/interpret 四个；知识条目必备 `topic/content/priority`，
   新增字段（`departments/source/status`）一律**可选**，缺省不报错（向后兼容 v1）。
2. **token 预算**：复用 `knowledge.py` 的估算口径（中文 `len(content)×1.5`），按 priority 降序贪心，
   选中片段总量 **不得超过** `budgetTokens`；同时报告因预算被丢弃的片段数。
3. **科室一致性**：`triage` 条目中声明的 `departments` 必须是 `config/triage-departments.json`
   白名单（含别名）的子集——防止知识库写了导诊开不出的科室。
4. **隐私**：不得出现手机号、身份证号、邮箱、银行卡号；不得含患者姓名占位（如「张某」）。
5. **内部信息**：不得写入 URL / IP / 端口 / 磁盘路径（知识库会进 prompt，等于对外输出）。
6. **占位标注**：`status=todo|partial` 的条目必须在 `metadata.todo` 中有对应说明，
   避免「未核实内容悄悄当事实用」。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
KB_PATH = REPO / "backend" / "ai-service" / "config" / "hospital-knowledge.json"
WHITELIST_PATH = REPO / "backend" / "ai-service" / "config" / "triage-departments.json"

REQUIRED_SCENARIOS = ("triage", "chat", "careplan", "interpret")
REQUIRED_METADATA = ("reviewedBy", "reviewedAt", "source")

PII_PATTERNS = {
    "手机号": re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"),
    "身份证": re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)"),
    "邮箱": re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"),
    "银行卡": re.compile(r"(?<!\d)\d{16,19}(?!\d)"),
    "姓名占位": re.compile(r"[张王李赵刘陈杨黄周吴]某"),
}
INTERNAL_PATTERNS = {
    "URL": re.compile(r"https?://", re.I),
    "IP": re.compile(r"(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)"),
    "端口": re.compile(r":\d{4,5}\b"),
    "磁盘路径": re.compile(r"[A-Za-z]:[\\/]"),
}


def estimate_tokens(text: str) -> int:
    """与 app/knowledge.py 保持同一口径（中文按字符数 ×1.5 粗估）。"""
    return int(len(text) * 1.5)


def select_items(items: list[dict], budget: int) -> tuple[list[dict], list[dict]]:
    """按 priority 降序贪心选取；放不下即停（整条丢弃，不切半句）——与运行时一致。"""
    ordered = sorted(items, key=lambda x: x.get("priority", 0), reverse=True)
    kept: list[dict] = []
    dropped: list[dict] = []
    used = 0
    for item in ordered:
        cost = estimate_tokens(item.get("content", ""))
        if used + cost <= budget and not dropped:
            kept.append(item)
            used += cost
        else:
            dropped.append(item)
    return kept, dropped


def load_whitelist() -> set[str]:
    data = json.loads(WHITELIST_PATH.read_text(encoding="utf-8"))
    names: set[str] = set()
    for dept in data.get("departments", []):
        name = str(dept.get("name") or "").strip()
        if name:
            names.add(name)
        for alias in dept.get("alias") or []:
            alias = str(alias).strip()
            if alias:
                names.add(alias)
    return names


def check() -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    report: dict = {"path": str(KB_PATH.relative_to(REPO)), "scenarios": {}}

    try:
        data = json.loads(KB_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"errors": [f"知识库文件不存在：{KB_PATH}"], "warnings": [], "scenarios": {}}
    except json.JSONDecodeError as exc:
        return {"errors": [f"JSON 解析失败：{exc}"], "warnings": [], "scenarios": {}}

    # ---- 1. schema ----
    version = str(data.get("version") or "")
    if not re.fullmatch(r"hospital-knowledge-v\d+", version):
        errors.append(f"version 不符合 hospital-knowledge-vN：{version!r}")
    report["version"] = version

    metadata = data.get("metadata") or {}
    for key in REQUIRED_METADATA:
        if not str(metadata.get(key) or "").strip():
            errors.append(f"metadata.{key} 缺失或为空")
    if not str(metadata.get("hospital") or "").strip():
        errors.append("metadata.hospital 缺失")
    report["reviewStatus"] = metadata.get("reviewStatus")
    report["todoCount"] = len(metadata.get("todo") or [])

    scenarios = data.get("scenarios") or {}
    missing = [s for s in REQUIRED_SCENARIOS if s not in scenarios]
    extra = [s for s in scenarios if s not in REQUIRED_SCENARIOS]
    if missing:
        errors.append(f"缺少场景：{missing}")
    if extra:
        warnings.append(f"存在未接入执行器的场景（不会被注入）：{extra}")

    whitelist = load_whitelist()
    todo_text = " ".join(str(x) for x in (metadata.get("todo") or []))

    for name in REQUIRED_SCENARIOS:
        block = scenarios.get(name)
        if not isinstance(block, dict):
            continue
        budget = int(block.get("budgetTokens") or 0)
        items = block.get("knowledge") or []
        if budget <= 0:
            errors.append(f"{name}: budgetTokens 缺失或非正数")
        if not items:
            errors.append(f"{name}: knowledge 为空")
            continue

        for idx, item in enumerate(items):
            where = f"{name}[{idx}]"
            for key in ("topic", "content"):
                if not str(item.get(key) or "").strip():
                    errors.append(f"{where}: 缺少 {key}")
            if not isinstance(item.get("priority"), int):
                errors.append(f"{where}: priority 必须是整数")
            # 可选字段类型校验（缺省即跳过，保证 v1 兼容）
            depts = item.get("departments")
            if depts is not None:
                if not isinstance(depts, list):
                    errors.append(f"{where}: departments 必须是数组")
                else:
                    unknown = [d for d in depts if d not in whitelist]
                    if unknown:
                        errors.append(f"{where}: departments 不在导诊白名单内 {unknown}")
            status = item.get("status")
            if status is not None and status not in ("verified", "partial", "todo"):
                errors.append(f"{where}: status 取值非法 {status!r}")
            if status in ("partial", "todo") and not todo_text:
                errors.append(f"{where}: status={status} 但 metadata.todo 为空（未核实项必须留 TODO）")

        kept, dropped = select_items(items, budget)
        used = sum(estimate_tokens(i.get("content", "")) for i in kept)
        report["scenarios"][name] = {
            "budget": budget,
            "used": used,
            "ratio": round(used / budget, 3) if budget else None,
            "kept": len(kept),
            "dropped": [d.get("topic") for d in dropped],
            "totalItems": len(items),
        }
        if used > budget:
            errors.append(f"{name}: 选中片段 {used} tokens 超过预算 {budget}")
        if dropped:
            warnings.append(
                f"{name}: 预算 {budget} 下丢弃 {len(dropped)} 条（{', '.join(d.get('topic','?') for d in dropped)}）"
            )

    # ---- 4/5. 隐私与内部信息（扫描全部 content/topic）----
    texts = []
    for name, block in scenarios.items():
        for item in (block or {}).get("knowledge") or []:
            texts.append((f"{name}/{item.get('topic','?')}", str(item.get("content", ""))))
    texts.append(("metadata.description", str(metadata.get("description", ""))))
    for where, text in texts:
        for label, pattern in {**PII_PATTERNS, **INTERNAL_PATTERNS}.items():
            if pattern.search(text):
                errors.append(f"{where}: 命中「{label}」敏感/内部信息规则")

    # ---- 6. 断言性文案提示（人工复核辅助，不算错误）----
    assert_words = ("24 小时", "24小时", "100%", "保证", "免费")
    for where, text in texts:
        for word in assert_words:
            if word in text:
                warnings.append(f"{where}: 含强断言词「{word}」，请确认有受控依据")

    return {"errors": errors, "warnings": warnings, **report}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON")
    args = parser.parse_args()

    result = check()
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result["errors"] else 0

    print(f"知识库：{result.get('path')} | version={result.get('version')} | reviewStatus={result.get('reviewStatus')}")
    print(f"{'场景':<12}{'预算':>6}{'已用':>6}{'占比':>8}{'保留':>6}{'丢弃':>6}")
    for name, row in (result.get("scenarios") or {}).items():
        print(f"{name:<12}{row['budget']:>6}{row['used']:>6}{str(row['ratio']):>8}{row['kept']:>6}{len(row['dropped']):>6}")
    for warning in result["warnings"]:
        print(f"  [WARN] {warning}")
    for error in result["errors"]:
        print(f"  [FAIL] {error}")
    print("结果：" + ("FAIL" if result["errors"] else "OK"))
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())

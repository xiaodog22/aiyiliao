"""接口层通用参数校验助手。"""

from __future__ import annotations

import re

from .. import db
from ..errors import ApiError


def require_fields(body: dict, fields: list[str]) -> None:
    missing = [f for f in fields if f not in body or body[f] is None or body[f] == ""]
    if missing:
        raise ApiError(400, "VALIDATION_FAILED", "缺少必需字段：" + "、".join(missing),
                       details=[{"field": f, "reason": "缺少必需字段"} for f in missing])


def check_unknown(body: dict, allowed: set[str]) -> None:
    unknown = [k for k in body if k not in allowed]
    if unknown:
        raise ApiError(400, "VALIDATION_FAILED", "请求包含未知字段：" + "、".join(sorted(unknown)),
                       details=[{"field": k, "reason": "未知字段"} for k in sorted(unknown)])


def as_str(body: dict, name: str, required: bool = False, max_len: int = 200,
           default: str = "", allow_blank: bool = False) -> str:
    value = body.get(name, default)
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ApiError(400, "VALIDATION_FAILED", f"{name} 必须为字符串",
                       details=[{"field": name, "reason": "类型错误"}])
    value = value.strip()
    if required and not value and not allow_blank:
        raise ApiError(400, "VALIDATION_FAILED", f"缺少必需字段：{name}",
                       details=[{"field": name, "reason": "缺少必需字段"}])
    if len(value) > max_len:
        raise ApiError(400, "VALIDATION_FAILED", f"{name} 长度不得超过 {max_len} 字符",
                       details=[{"field": name, "reason": "超长"}])
    return value


def as_int(body: dict, name: str, required: bool = False, default: int = 0,
           minimum: int | None = None, maximum: int | None = None) -> int:
    value = body.get(name, default)
    if value is None or value == "":
        if required:
            raise ApiError(400, "VALIDATION_FAILED", f"缺少必需字段：{name}",
                           details=[{"field": name, "reason": "缺少必需字段"}])
        return default
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ApiError(400, "VALIDATION_FAILED", f"{name} 必须为整数",
                       details=[{"field": name, "reason": "类型错误"}])
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ApiError(400, "VALIDATION_FAILED", f"{name} 必须为整数",
                       details=[{"field": name, "reason": "类型错误"}])
    if minimum is not None and number < minimum:
        raise ApiError(400, "VALIDATION_FAILED", f"{name} 不得小于 {minimum}",
                       details=[{"field": name, "reason": "小于下限"}])
    if maximum is not None and number > maximum:
        raise ApiError(400, "VALIDATION_FAILED", f"{name} 不得大于 {maximum}",
                       details=[{"field": name, "reason": "大于上限"}])
    return number


def as_float(body: dict, name: str, default: float = 0.0,
             minimum: float | None = None, maximum: float | None = None) -> float:
    value = body.get(name, default)
    if value is None or value == "":
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ApiError(400, "VALIDATION_FAILED", f"{name} 必须为数字",
                       details=[{"field": name, "reason": "类型错误"}])
    if minimum is not None and number < minimum:
        raise ApiError(400, "VALIDATION_FAILED", f"{name} 不得小于 {minimum}",
                       details=[{"field": name, "reason": "小于下限"}])
    if maximum is not None and number > maximum:
        raise ApiError(400, "VALIDATION_FAILED", f"{name} 不得大于 {maximum}",
                       details=[{"field": name, "reason": "大于上限"}])
    return round(number, 2)


def as_list(body: dict, name: str, required: bool = True, max_items: int = 50) -> list:
    value = body.get(name)
    if value is None:
        if required:
            raise ApiError(400, "VALIDATION_FAILED", f"缺少必需字段：{name}",
                           details=[{"field": name, "reason": "缺少必需字段"}])
        return []
    if not isinstance(value, list):
        raise ApiError(400, "VALIDATION_FAILED", f"{name} 必须为数组",
                       details=[{"field": name, "reason": "类型错误"}])
    if len(value) > max_items:
        raise ApiError(400, "VALIDATION_FAILED", f"{name} 数量不得超过 {max_items} 项")
    return value


def one_of(value: str, allowed: set[str], field: str) -> str:
    if value not in allowed:
        raise ApiError(400, "VALIDATION_FAILED",
                       f"{field} 取值须为 {'/'.join(sorted(allowed))} 之一",
                       details=[{"field": field, "reason": "不在枚举范围内"}])
    return value


def parse_date(value: str, field: str = "date", default_today: bool = True) -> str:
    if not value:
        if default_today:
            return db.today_str()
        raise ApiError(400, "VALIDATION_FAILED", f"缺少 {field}")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ApiError(400, "VALIDATION_FAILED", f"{field} 格式须为 YYYY-MM-DD",
                       details=[{"field": field, "reason": "格式错误"}])
    return value


def pagination(query: dict, default_limit: int = 100, max_limit: int = 300) -> tuple[int, int]:
    try:
        limit = int(query.get("limit") or default_limit)
        offset = int(query.get("offset") or 0)
    except ValueError:
        raise ApiError(400, "VALIDATION_FAILED", "分页参数必须为整数")
    limit = max(1, min(limit, max_limit))
    offset = max(0, offset)
    return limit, offset


VITALS_RANGES = {
    "temperature": (30, 45, "体温"),
    "pulse": (20, 250, "脉搏"),
    "respiration": (5, 60, "呼吸"),
    "systolic": (50, 300, "收缩压"),
    "diastolic": (20, 200, "舒张压"),
    "spo2": (50, 100, "血氧"),
}


def parse_vitals(body: dict) -> dict:
    """体征数值校验：体温 30~45、脉搏 20~250、呼吸 5~60、收缩压 50~300、舒张压 20~200、血氧 50~100。"""
    result = {}
    for key, (low, high, label) in VITALS_RANGES.items():
        if key not in body or body[key] in (None, ""):
            continue
        try:
            number = float(body[key])
        except (TypeError, ValueError):
            raise ApiError(400, "INVALID_VITALS", f"{label}必须为数字",
                           details=[{"field": key, "reason": "类型错误"}])
        if key == "temperature":
            number = round(number, 1)
        else:
            number = int(round(number))
        if number < low or number > high:
            raise ApiError(400, "INVALID_VITALS", f"{label}须在 {low}~{high} 之间",
                           details=[{"field": key, "reason": "超出合理范围"}])
        result[key] = number
    return result


def staff_is_active(con, staff_id: int) -> bool:
    row = con.execute("SELECT status FROM staff WHERE id=?", (staff_id,)).fetchone()
    return bool(row and row["status"] == "ACTIVE")
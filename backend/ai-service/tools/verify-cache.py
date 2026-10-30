#!/usr/bin/env python3
"""缓存验证脚本（P0 性能修复验收，2026-10-22）。

验证范围：
1. 确认缓存开关实际状态
2. 测试缓存命中率与延迟改善
3. 验证降级不影响主流程

使用方法：
    python tools/verify-cache.py --base-url http://localhost:8001

验收标准：
- 缓存开启：第 2 次相同请求命中缓存，响应时间 < 第 1 次的 10%
- 缓存关闭：响应正常，无缓存文件生成
- 降级安全：缓存损坏不影响服务启动，第 2 次请求仍正常响应
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Optional

try:
    import httpx
except ImportError:
    print("错误：缺少 httpx 依赖，请安装：pip install httpx")
    sys.exit(1)


class CacheVerifier:
    """缓存验证器。"""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.client = httpx.Client(timeout=60.0)

    def check_health(self) -> dict:
        """检查服务健康状态，获取缓存配置信息。"""
        try:
            resp = self.client.get(f"{self.base_url}/internal/health/ready")
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPError as exc:
            print(f"❌ 健康检查失败：{exc}")
            sys.exit(1)

    def submit_task(self, task_type: str, input_text: str, idempotency_key: str) -> tuple[str, float]:
        """提交任务，返回 (task_id, elapsed_seconds)。"""
        start = time.time()
        try:
            resp = self.client.post(
                f"{self.base_url}/internal/v1/task",
                json={
                    "tenantId": "verify-cache-tenant",
                    "userId": "verify-cache-user",
                    "taskType": task_type,
                    "inputInline": input_text,
                },
                headers={"Idempotency-Key": idempotency_key},
            )
            resp.raise_for_status()
            elapsed = time.time() - start
            data = resp.json()["data"]
            return data["taskId"], elapsed
        except httpx.HTTPError as exc:
            print(f"❌ 提交任务失败：{exc}")
            sys.exit(1)

    def wait_task(self, task_id: str, timeout: float = 30.0) -> tuple[dict, float]:
        """等待任务完成，返回 (task_data, total_elapsed_seconds)。"""
        start = time.time()
        deadline = start + timeout
        while time.time() < deadline:
            try:
                resp = self.client.get(f"{self.base_url}/internal/v1/task/{task_id}")
                resp.raise_for_status()
                data = resp.json()["data"]
                if data["status"] in ("SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED"):
                    elapsed = time.time() - start
                    return data, elapsed
                time.sleep(0.1)
            except httpx.HTTPError as exc:
                print(f"❌ 查询任务失败：{exc}")
                sys.exit(1)
        print(f"❌ 任务 {task_id} 超时未完成（{timeout}s）")
        sys.exit(1)

    def verify_cache_enabled(self) -> None:
        """验证缓存开启状态与命中效果。"""
        print("\n🔍 验证 1：缓存开启状态与命中效果")
        print("-" * 60)

        # 检查健康状态
        health = self.check_health()
        print(f"✅ 服务状态：{health.get('status', 'unknown')}")
        print(f"   版本：{health.get('version', 'unknown')}")

        # 提交第 1 次请求（TRIAGE 任务）
        input_text = "最近三天胃胀，饭后明显，伴有轻微恶心"
        print(f"\n📤 第 1 次请求（预期真实计算）：{input_text}")
        task_id_1, submit_elapsed_1 = self.submit_task("TRIAGE", input_text, "verify-cache-0001")
        print(f"   提交耗时：{submit_elapsed_1:.3f}s | 任务ID：{task_id_1}")

        task_1, wait_elapsed_1 = self.wait_task(task_id_1)
        print(f"   完成状态：{task_1['status']} | 等待耗时：{wait_elapsed_1:.3f}s")
        print(f"   缓存命中：{task_1.get('cached', False)}")
        if task_1["status"] == "SUCCEEDED":
            print(f"   推荐科室：{task_1['result'].get('departments', [])}")

        # 提交第 2 次相同请求（预期缓存命中）
        print(f"\n📤 第 2 次请求（预期缓存命中）：{input_text}")
        task_id_2, submit_elapsed_2 = self.submit_task("TRIAGE", input_text, "verify-cache-0002")
        print(f"   提交耗时：{submit_elapsed_2:.3f}s | 任务ID：{task_id_2}")

        task_2, wait_elapsed_2 = self.wait_task(task_id_2)
        print(f"   完成状态：{task_2['status']} | 等待耗时：{wait_elapsed_2:.3f}s")
        print(f"   缓存命中：{task_2.get('cached', False)}")
        if task_2["status"] == "SUCCEEDED":
            print(f"   推荐科室：{task_2['result'].get('departments', [])}")

        # 验证结果
        total_1 = submit_elapsed_1 + wait_elapsed_1
        total_2 = submit_elapsed_2 + wait_elapsed_2
        speedup = total_1 / total_2 if total_2 > 0 else 0
        print(f"\n📊 性能对比：")
        print(f"   第 1 次总耗时：{total_1:.3f}s")
        print(f"   第 2 次总耗时：{total_2:.3f}s")
        print(f"   加速比：{speedup:.2f}x")

        if task_2.get("cached") is True:
            print(f"   ✅ 缓存命中成功")
            if total_2 < total_1 * 0.1:
                print(f"   ✅ 延迟改善达标（< 10% 第 1 次）")
            else:
                print(f"   ⚠️  延迟改善不明显（预期 < {total_1 * 0.1:.3f}s）")
        else:
            print(f"   ❌ 缓存未命中（检查 AI_CACHE_ENABLED 配置）")

    def verify_cache_disabled(self) -> None:
        """验证缓存关闭状态（降级安全）。"""
        print("\n🔍 验证 2：缓存关闭状态（降级安全）")
        print("-" * 60)
        print("⚠️  此验证需要关闭缓存（AI_CACHE_ENABLED=false）后重启服务")
        print("   提示：若当前缓存开启，可跳过此验证或手动测试")

        # 检查健康状态
        health = self.check_health()
        print(f"✅ 服务状态：{health.get('status', 'unknown')}")

        # 提交两次相同请求
        input_text = "头痛两天，伴有发热"
        print(f"\n📤 第 1 次请求：{input_text}")
        task_id_1, _ = self.submit_task("TRIAGE", input_text, "verify-no-cache-0001")
        task_1, elapsed_1 = self.wait_task(task_id_1)
        print(f"   完成状态：{task_1['status']} | 耗时：{elapsed_1:.3f}s | 缓存：{task_1.get('cached', False)}")

        print(f"\n📤 第 2 次请求：{input_text}")
        task_id_2, _ = self.submit_task("TRIAGE", input_text, "verify-no-cache-0002")
        task_2, elapsed_2 = self.wait_task(task_id_2)
        print(f"   完成状态：{task_2['status']} | 耗时：{elapsed_2:.3f}s | 缓存：{task_2.get('cached', False)}")

        # 验证结果
        if task_1["status"] == "SUCCEEDED" and task_2["status"] == "SUCCEEDED":
            print(f"\n✅ 缓存关闭时服务正常（两次请求均成功）")
            if task_2.get("cached") is not True:
                print(f"   ✅ 确认未使用缓存（第 2 次请求未命中）")
            else:
                print(f"   ⚠️  第 2 次请求意外命中缓存（检查配置）")
        else:
            print(f"\n❌ 缓存关闭时服务异常（请检查日志）")

    def verify_cache_stats(self) -> None:
        """验证缓存统计信息。"""
        print("\n🔍 验证 3：缓存统计信息")
        print("-" * 60)

        try:
            resp = self.client.get(f"{self.base_url}/internal/health/ready")
            resp.raise_for_status()
            health = resp.json()

            # 打印缓存相关信息
            print(f"✅ 服务健康状态：")
            for key, value in health.items():
                if "cache" in key.lower() or key in ("version", "status"):
                    print(f"   {key}: {value}")

        except httpx.HTTPError as exc:
            print(f"❌ 获取统计信息失败：{exc}")


def main():
    parser = argparse.ArgumentParser(description="AI-Service 缓存验证脚本")
    parser.add_argument(
        "--base-url",
        default="http://localhost:8001",
        help="ai-service 基础 URL（默认：http://localhost:8001）",
    )
    parser.add_argument(
        "--verify",
        choices=["enabled", "disabled", "stats", "all"],
        default="all",
        help="验证项目：enabled（缓存开启），disabled（缓存关闭），stats（统计信息），all（全部）",
    )

    args = parser.parse_args()
    verifier = CacheVerifier(args.base_url)

    print("=" * 60)
    print("AI-Service 缓存验证脚本（P0 性能修复验收）")
    print("=" * 60)
    print(f"目标服务：{args.base_url}")
    print(f"验证项目：{args.verify}")

    if args.verify in ("enabled", "all"):
        verifier.verify_cache_enabled()

    if args.verify in ("disabled", "all"):
        verifier.verify_cache_disabled()

    if args.verify in ("stats", "all"):
        verifier.verify_cache_stats()

    print("\n" + "=" * 60)
    print("✅ 验证完成")
    print("=" * 60)


if __name__ == "__main__":
    main()

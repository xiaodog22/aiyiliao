#!/usr/bin/env python3
"""ASR 性能基准测试：验证单例化改造后的性能提升。

使用方法：
1. 启动 ai-service（确保 AI_ASR_ENGINE=funasr 和 AI_ASR_MODEL_PATH 已配置）
2. 准备测试音频文件（16kHz MP3，放入 runtime/asr/ 目录）
3. 运行：python tools/benchmark-asr.py

预期结果：
- 第 1 次请求：10~30s（首次加载模型，若启用预热则 <2s）
- 第 2~5 次请求：0.5~2s（复用单例模型）
"""

import asyncio
import hashlib
import json
import time
from pathlib import Path

import httpx

# 测试配置
BASE_URL = "http://127.0.0.1:8001"
SERVICE_TOKEN = "dev-token-12345"  # 根据实际配置调整
TEST_AUDIO_PATH = Path(__file__).parent.parent / "runtime" / "asr" / "test-sample.mp3"
TEST_ITERATIONS = 5


async def benchmark_asr():
    """运行 ASR 性能基准测试。"""
    if not TEST_AUDIO_PATH.exists():
        print(f"❌ 测试音频文件不存在: {TEST_AUDIO_PATH}")
        print("请准备一个 16kHz MP3 音频文件并放入该路径。")
        return

    print(f"🔍 ASR 性能基准测试")
    print(f"   基准 URL: {BASE_URL}")
    print(f"   音频文件: {TEST_AUDIO_PATH}")
    print(f"   迭代次数: {TEST_ITERATIONS}")
    print()

    # 1. 检查就绪探针
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await client.get(f"{BASE_URL}/internal/health/ready")
            if resp.status_code != 200:
                print(f"❌ 就绪探针失败: {resp.status_code}")
                return
            
            ready = resp.json()
            asr_status = ready.get("dependencies", {}).get("asr_model", {}).get("status")
            if asr_status != "available":
                print(f"❌ ASR 模型未就绪: status={asr_status}")
                return
            
            print(f"✓ ASR 模型已就绪")
            print()
        except Exception as exc:
            print(f"❌ 连接失败: {exc}")
            return

    # 2. 准备测试任务
    audio_ref = f"asr:test-sample"  # 约定：inputRef → runtime/asr/test-sample.mp3
    
    # 3. 运行基准测试
    timings = []
    async with httpx.AsyncClient(timeout=120.0) as client:
        headers = {"Authorization": f"Bearer {SERVICE_TOKEN}"}
        
        for i in range(TEST_ITERATIONS):
            start = time.time()
            
            # 提交任务
            task_data = {
                "taskType": "ASR",
                "idempotencyKey": f"bench-asr-{i}-{int(start)}",
                "inputRef": audio_ref,
                "locale": "zh-CN",
            }
            
            try:
                submit_resp = await client.post(
                    f"{BASE_URL}/internal/v1/task",
                    json=task_data,
                    headers=headers,
                )
                
                if submit_resp.status_code != 200:
                    print(f"❌ 第 {i+1} 次提交失败: {submit_resp.status_code}")
                    print(submit_resp.text)
                    continue
                
                task_id = submit_resp.json()["taskId"]
                
                # 轮询直到完成
                while True:
                    await asyncio.sleep(0.5)
                    get_resp = await client.get(
                        f"{BASE_URL}/internal/v1/task/{task_id}",
                        headers=headers,
                    )
                    
                    if get_resp.status_code != 200:
                        print(f"❌ 第 {i+1} 次查询失败: {get_resp.status_code}")
                        break
                    
                    task = get_resp.json()
                    status = task["status"]
                    
                    if status in ("SUCCEEDED", "FAILED"):
                        elapsed = time.time() - start
                        timings.append(elapsed)
                        
                        if status == "SUCCEEDED":
                            transcript = task.get("result", {}).get("transcript", "")
                            print(f"✓ 第 {i+1} 次: {elapsed:.2f}s | 文本: {transcript[:30]}...")
                        else:
                            error_code = task.get("error", {}).get("code", "UNKNOWN")
                            print(f"❌ 第 {i+1} 次失败: {elapsed:.2f}s | 错误: {error_code}")
                        break
            
            except Exception as exc:
                elapsed = time.time() - start
                print(f"❌ 第 {i+1} 次异常: {elapsed:.2f}s | {exc}")
    
    # 4. 统计报告
    print()
    print("=" * 60)
    print("📊 ASR 性能基准测试结果")
    print("=" * 60)
    
    if not timings:
        print("❌ 无有效测试数据")
        return
    
    print(f"总请求数: {len(timings)}")
    print(f"首次耗时: {timings[0]:.2f}s")
    
    if len(timings) > 1:
        subsequent = timings[1:]
        avg = sum(subsequent) / len(subsequent)
        min_time = min(subsequent)
        max_time = max(subsequent)
        
        print(f"后续耗时: 平均 {avg:.2f}s | 最小 {min_time:.2f}s | 最大 {max_time:.2f}s")
        print()
        print("✅ 验收标准:")
        print(f"   首次: {'✓ PASS' if timings[0] < 35 else '✗ FAIL (>35s)'}")
        print(f"   后续平均: {'✓ PASS' if avg < 3 else '✗ FAIL (>3s)'}")
    else:
        print("⚠️  仅一次测试，无法评估后续性能")
    
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(benchmark_asr())

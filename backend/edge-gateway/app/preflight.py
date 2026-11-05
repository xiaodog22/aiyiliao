"""启动期运行时依赖自检（PERF-07 衍生，2026-11-01）。

为什么需要这个：2026-11-01 压测发现 venv 里缺 `sniffio`，导致 anyio 的
`current_async_library()` 每次调用都重走完整 sys.path 扫描找一个永远找不到的模块，
**吃掉了 48.6% 的 CPU**，网关吞吐被钉在 143 RPS（补装后 296 RPS）。

`pip check` 完全查不出来 —— 因为没有任何包**声明**依赖 sniffio（anyio 4.x 把它当可选依赖）。
这类"可选依赖缺失 + 热路径上失败导入"的缺陷，只有两种发现方式：函数级采样、或启动期主动探测。

本模块做后者：启动时探一遍热路径依赖，并在缺失时给出**可执行的修复命令**。
设计约束：
  - 只告警不阻截：缺依赖时网关仍应能起来（宁可慢，不可不可用）；
  - 探测本身要快：单次 `import` 命中缓存是纳秒级，整个自检 < 5ms；
  - 不引入新依赖：只用标准库 importlib。
"""

import importlib
import logging
import time

logger = logging.getLogger("edge_gateway.preflight")

# 热路径依赖清单：(模块名, 缺失后果, 是否阻断级)
# 判定原则：只收录「没有包声明依赖它」或「声明了但极易在重建 venv 时丢失」的运行期必需项。
_HOT_PATH_DEPS = (
    (
        "sniffio",
        "anyio 的 current_async_library() 会退化为每次重扫 sys.path，"
        "实测吃掉 48.6% CPU、吞吐 296→143 RPS",
    ),
    (
        "h11",
        "httpcore 的 HTTP/1.1 协议实现；缺失则 httpx 全部转发失败",
    ),
    (
        "anyio",
        "httpx 的异步后端；缺失则 AsyncClient 无法创建",
    ),
)


def check_hot_path_deps() -> list:
    """探测热路径依赖，返回缺失项列表 [(模块名, 后果)]。全齐则返回空列表。"""
    missing = []
    for name, consequence in _HOT_PATH_DEPS:
        try:
            importlib.import_module(name)
        except Exception:  # noqa: BLE001 - 任何导入失败都算缺失，不让自检自身抛错
            missing.append((name, consequence))
    return missing


def measure_async_library_probe() -> float:
    """量测 `current_async_library()` 的单次成本（毫秒，100 次均值）。

    这是 sniffio 是否健康的**行为级**判据：正常 < 0.01ms，缺失时可达 0.1~1ms。
    比"能否 import"更强 —— 即便 import 成功，若 sys.path 异常也会拖慢。
    同步上下文调用会抛 AsyncLibraryNotFoundError，这里视为正常（只关心耗时）。

    返回 -1 表示探测本身不可用（anyio 版本差异导致函数搬家），此时只能依赖 import 检查。
    导入路径随 anyio 版本变：3.x/4.x 在 `anyio._core._eventloop`，部分版本再导出到 `anyio.lowlevel`。
    """
    fn = None
    for mod_path in ("anyio.lowlevel", "anyio._core._eventloop"):
        try:
            mod = importlib.import_module(mod_path)
            fn = getattr(mod, "current_async_library", None)
        except Exception:  # noqa: BLE001
            fn = None
        if fn is not None:
            break
    if fn is None:
        return -1.0
    rounds = 100
    started = time.perf_counter()
    for _ in range(rounds):
        try:
            fn()
        except Exception:  # noqa: BLE001 - 同步上下文抛错属正常，不中断计时
            pass
    return (time.perf_counter() - started) * 1000.0 / rounds


def run_startup_check() -> None:
    """启动期执行：缺失依赖 → ERROR + 修复命令；探测超阈值 → WARNING。绝不抛异常。"""
    missing = check_hot_path_deps()
    if missing:
        for name, consequence in missing:
            logger.error(
                "热路径依赖缺失：%s —— %s。修复：.venv/Scripts/python.exe -m pip install %s",
                name, consequence, name,
            )
        logger.error(
            "共 %d 项热路径依赖缺失。注意：pip check 对可选依赖无效，不会报出本问题。",
            len(missing),
        )
        return

    probe_ms = measure_async_library_probe()
    if probe_ms < 0:
        logger.info("运行时依赖自检通过 | 热路径依赖 %d 项齐备 | 行为探测不可用（anyio 版本差异），仅做导入检查",
                    len(_HOT_PATH_DEPS))
        return
    if probe_ms > 0.05:
        # 阈值 0.05ms：正常命中缓存是 <0.01ms；超过 5 倍即认为 sys.path 或模块缓存异常
        logger.warning(
            "current_async_library() 单次 %.4fms 偏慢（正常 <0.01ms），"
            "疑似 sys.path 异常或模块缓存未命中，高并发下会放大为 CPU 热点", probe_ms,
        )
    else:
        logger.info("运行时依赖自检通过 | 热路径依赖 %d 项齐备 | probe=%.4fms",
                    len(_HOT_PATH_DEPS), probe_ms)

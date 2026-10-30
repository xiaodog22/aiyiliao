"""
院内知识库加载与注入模块（2026-10-22）

核心功能：
- 从 config/hospital-knowledge.json 加载院内知识库（版本化、分场景）
- Token 预算控制（按优先级选择片段，超预算截断）
- 降级安全（知识库缺失/损坏时回退到通用 prompt，记录 WARNING）
- 隐私保护（日志中不记录患者标识）

使用示例：
    loader = KnowledgeLoader(config_path=Path("config/hospital-knowledge.json"))
    knowledge_text = loader.get_knowledge("triage", budget_tokens=300)
    # 返回 "本院开设科室：全科医学科、消化内科……" 或空字符串（降级）
"""

import json
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


class KnowledgeLoader:
    """院内知识库加载器（版本化、Token 预算控制、降级安全）"""

    def __init__(self, config_path: Path):
        """
        初始化知识库加载器

        Args:
            config_path: 知识库配置文件路径（JSON 格式）
        """
        self.config_path = config_path
        self._knowledge_data: Optional[dict] = None
        self._version: Optional[str] = None
        self._load_knowledge()

    def _load_knowledge(self) -> None:
        """
        从配置文件加载知识库

        降级策略：文件缺失/损坏 → 记录 WARNING，_knowledge_data 保持 None
        """
        if not self.config_path.exists():
            logger.warning(
                "院内知识库配置文件不存在：%s，所有场景将降级为通用 prompt",
                self.config_path,
            )
            return

        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            # 校验必需字段
            if "version" not in data or "scenarios" not in data:
                logger.warning(
                    "院内知识库配置格式错误（缺少 version 或 scenarios）：%s，降级为通用 prompt",
                    self.config_path,
                )
                return

            self._knowledge_data = data
            self._version = data["version"]
            logger.info(
                "院内知识库已加载 | 版本=%s | 场景数=%d | 文件=%s",
                self._version,
                len(data["scenarios"]),
                self.config_path,
            )

        except json.JSONDecodeError as e:
            logger.warning(
                "院内知识库配置文件损坏（JSON 解析失败）：%s | 错误=%s，降级为通用 prompt",
                self.config_path,
                str(e),
            )
        except Exception as e:
            logger.warning(
                "院内知识库加载失败：%s | 错误=%s，降级为通用 prompt",
                self.config_path,
                str(e),
            )

    def get_knowledge(
        self,
        scenario: str,
        budget_tokens: Optional[int] = None,
    ) -> str:
        """
        获取指定场景的知识库片段（按优先级选择，遵守 token 预算）

        Args:
            scenario: 场景名称（"triage"/"chat"/"careplan"/"interpret"）
            budget_tokens: Token 预算上限（None=使用场景默认预算）

        Returns:
            知识库文本（多个片段用 "\n\n" 连接）或空字符串（降级）

        降级策略：
        - 知识库未加载 → 空字符串 + WARNING（已在 _load_knowledge 记录）
        - 场景不存在 → 空字符串 + WARNING
        - 知识片段为空 → 空字符串 + INFO
        - 超预算 → 截断低优先级片段 + INFO
        """
        # 降级：知识库未加载
        if self._knowledge_data is None:
            return ""

        scenarios = self._knowledge_data.get("scenarios", {})

        # 降级：场景不存在
        if scenario not in scenarios:
            logger.warning(
                "院内知识库场景不存在：%s，降级为通用 prompt | 可用场景=%s",
                scenario,
                list(scenarios.keys()),
            )
            return ""

        scenario_data = scenarios[scenario]
        knowledge_items = scenario_data.get("knowledge", [])

        # 降级：知识片段为空
        if not knowledge_items:
            logger.info(
                "院内知识库场景 %s 无知识片段，降级为通用 prompt",
                scenario,
            )
            return ""

        # 使用场景默认预算（如果未指定）
        if budget_tokens is None:
            budget_tokens = scenario_data.get("budgetTokens", 500)

        # 按优先级排序（降序）
        sorted_items = sorted(
            knowledge_items,
            key=lambda x: x.get("priority", 0),
            reverse=True,
        )

        # Token 预算控制（简单估算：中文字符数 × 1.5）
        selected_items = []
        total_tokens = 0

        for item in sorted_items:
            content = item.get("content", "")
            estimated_tokens = int(len(content) * 1.5)  # 中文粗略估算

            if total_tokens + estimated_tokens <= budget_tokens:
                selected_items.append(content)
                total_tokens += estimated_tokens
            else:
                logger.info(
                    "院内知识库场景 %s 超预算，截断低优先级片段 | 预算=%d tokens | 已用=%d tokens | 丢弃=%d 个片段",
                    scenario,
                    budget_tokens,
                    total_tokens,
                    len(sorted_items) - len(selected_items),
                )
                break

        knowledge_text = "\n\n".join(selected_items)

        logger.info(
            "院内知识库场景 %s 注入成功 | 片段数=%d | 估算 tokens=%d / %d",
            scenario,
            len(selected_items),
            total_tokens,
            budget_tokens,
        )

        return knowledge_text

    @property
    def version(self) -> str:
        """知识库版本号（未加载/降级时为 "unknown"）"""
        return self._version if self._version is not None else "unknown"

    @property
    def is_loaded(self) -> bool:
        """知识库是否成功加载"""
        return self._knowledge_data is not None


# 全局缓存（按配置路径缓存，同一路径复用同一实例）
_knowledge_loader_cache: dict[str, "KnowledgeLoader"] = {}

# 默认配置路径（与 Settings.knowledge_base_path 默认值保持一致）
_DEFAULT_KNOWLEDGE_CONFIG_PATH = (
    Path(__file__).resolve().parent.parent / "config" / "hospital-knowledge.json"
)


def get_knowledge_loader(config_path: Optional[Path] = None) -> KnowledgeLoader:
    """
    获取知识库加载器（按配置路径缓存，同一路径返回同一实例）

    Args:
        config_path: 配置文件路径（None 时使用默认 config/hospital-knowledge.json）

    Returns:
        KnowledgeLoader 实例

    说明：
    - 同一路径多次调用返回同一实例（避免重复读取磁盘）
    - 不同路径返回不同实例（便于测试与多知识库场景）
    - 缓存键使用 resolve() 后的绝对路径，避免相对路径写法差异导致重复加载
    """
    resolved = (
        Path(config_path) if config_path is not None else _DEFAULT_KNOWLEDGE_CONFIG_PATH
    )
    try:
        key = str(resolved.resolve())
    except OSError:  # 极端情况下路径无法解析，退化为原字符串
        key = str(resolved)

    loader = _knowledge_loader_cache.get(key)
    if loader is None:
        loader = KnowledgeLoader(resolved)
        _knowledge_loader_cache[key] = loader

    return loader

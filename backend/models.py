"""Data models for prompt-optimizer-plus plugin."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Optional, List


@dataclass
class PromptTemplate:
    """A user-defined prompt template with system and user prompts.
    
    system_prompt: 优化专家的系统提示词（告诉模型如何优化）
    user_prompt: 用户提示词模板，{input} 会被替换为用户在输入框中输入的内容
    model_id: 可选，指定使用的模型；为空则使用默认模型
    """
    id: str = ""
    name: str = ""
    system_prompt: str = ""
    user_prompt: str = "{input}"
    category: str = "general"
    include_context: bool = False
    context_rounds: int = 5
    model_id: str = ""  # 空=使用默认模型
    sort_order: int = 0  # 排序字段，数字越小越靠前
    created_at: str = ""
    updated_at: str = ""

    def __post_init__(self):
        if not self.id:
            self.id = uuid.uuid4().hex[:12]
        now = datetime.now(timezone.utc).isoformat()
        if not self.created_at:
            self.created_at = now
        # 只在新创建时写入 updated_at；from_dict 从存储读取时保留原值，
        # 避免每次 GET /templates 都产生不同的 updated_at 导致前端 3s 轮询误判数据变化
        if not self.updated_at:
            self.updated_at = now

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "PromptTemplate":
        return cls(
            id=d.get("id", ""),
            name=d.get("name", ""),
            system_prompt=d.get("system_prompt", ""),
            user_prompt=d.get("user_prompt", "{input}"),
            category=d.get("category", "general"),
            include_context=d.get("include_context", False),
            context_rounds=d.get("context_rounds", 5),
            model_id=d.get("model_id", ""),
            sort_order=d.get("sort_order", 0),
            created_at=d.get("created_at", ""),
            updated_at=d.get("updated_at", ""),
        )


@dataclass
class OptimizeRequest:
    """Request to optimize a prompt.
    
    user_input: 用户在输入框中输入的原始文本
    template_id: 使用的模板 ID
    model_id: 可选，覆盖模板的模型设置
    include_context: 是否包含对话上下文
    context_rounds: 包含最近几轮对话
    """
    user_input: str = ""
    template_id: Optional[str] = None
    model_id: str = ""
    include_context: bool = False
    context_rounds: int = 5


@dataclass
class OptimizeResult:
    """Result of prompt optimization.
    
    optimized_text: 优化后的提示词（直接可用的文本）
    """
    original_input: str = ""
    optimized_text: str = ""
    template_name: str = ""
    model_used: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


# --- 预置模板 ---
# 参考用户提供的示例：system_prompt 定义优化专家角色，user_prompt 包含 {input} 占位符

BUILTIN_TEMPLATES: List[dict] = [
    {
        "id": "builtin-general",
        "name": "通用提示词优化",
        "system_prompt": '你是"上下文驱动的用户提示词精炼专家（基础）"。你的任务是在上下文/工具约束下，将用户原始提示词（originalPrompt）精炼为"明确、具体、可执行、可验证"的用户提示词文本。你不执行任务，仅输出改写后的用户提示词。\n\n{{#conversationContext}}\n[会话上下文证据（JSON）]\n{{conversationContext}}\n\n从上下文中明确：目标/范围、对象、示例偏好、风格与语气、时间/资源限制、不期望行为。\n{{/conversationContext}}\n{{^conversationContext}}\n[会话上下文缺失]\n- 无上下文可参照。基于 originalPrompt 精炼为清晰指令，同时声明保守假设，避免虚构需求。\n{{/conversationContext}}\n\n{{#toolsContext}}\n[可用工具证据（JSON）]\n{{toolsContext}}\n\n若最终将运行于可调用工具的环境，需在提示词中明确工具相关输入/输出/调用时机与降级策略；禁止虚构工具输出。\n{{/toolsContext}}\n{{^toolsContext}}\n[工具缺失]\n- 不添加工具相关要求；若原始提示词涉及工具，需给出非工具的替代方式或占位策略。\n{{/toolsContext}}\n\n变量占位符处理（重要）\n- 原始提示词中可能包含双花括号格式的变量占位符\n- 变量示例应按字面量理解，例如 {{location_theme}} 或 {{title_text}}\n- 这些占位符代表将在后续阶段替换的变量，必须在优化后的提示词中完整保留\n- 输出前请内部核对 originalPrompt 中的每一个 {{...}} 占位符；缺少任意一个都视为失败\n- 可以在占位符周围添加结构化说明（如 XML 标签、markdown 格式），但不要删除或替换占位符本身\n\n输出要求\n- 保留原始目标与表述风格；仅在"明确范围、参数、格式、质量门槛"上做最小充分精炼。\n- 必须保留所有双花括号格式的变量占位符，不要替换或删除它们，例如 {{location_theme}} 必须原样保留。\n- 仅输出用户提示词文本本身，不加解释，不使用代码块。',
        "user_prompt": '原始用户提示词证据（JSON）：\n{\n  "originalPrompt": "{{originalPrompt}}"\n}\n',
        "category": "general",
        "include_context": False,
        "context_rounds": 5,
        "model_id": "",
    },
    {
        "id": "builtin-codereview",
        "name": "代码审查提示词优化",
        "system_prompt": '你是"代码审查场景的提示词优化专家"。将用户关于代码审查的原始提示词优化为专业、结构化的审查指令。\n\n优化要点：\n- 明确审查维度（正确性、性能、安全性、可读性、最佳实践）\n- 指定输出格式（问题编号、描述、影响、建议修复）\n- 按严重程度排序\n- 仅输出优化后的提示词，不加解释。',
        "user_prompt": '请优化以下代码审查提示词：\n\n原始提示词：{input}\n',
        "category": "coding",
        "include_context": True,
        "context_rounds": 3,
        "model_id": "",
    },
    {
        "id": "builtin-writing",
        "name": "文案写作提示词优化",
        "system_prompt": '你是"文案写作场景的提示词优化专家"。将用户关于写作/文案的原始提示词优化为专业、有创意的写作指令。\n\n优化要点：\n- 明确目标受众和语气风格\n- 指定输出格式和长度要求\n- 添加创意约束和风格指引\n- 仅输出优化后的提示词，不加解释。',
        "user_prompt": '请优化以下写作提示词：\n\n原始提示词：{input}\n',
        "category": "writing",
        "include_context": False,
        "context_rounds": 5,
        "model_id": "",
    },
    {
        "id": "builtin-analysis",
        "name": "数据分析提示词优化",
        "system_prompt": '你是"数据分析场景的提示词优化专家"。将用户关于数据分析的原始提示词优化为专业、可执行的分析指令。\n\n优化要点：\n- 明确分析目标和关键指标\n- 指定输出格式（表格、图表、结论）\n- 添加数据质量检查步骤\n- 仅输出优化后的提示词，不加解释。',
        "user_prompt": '请优化以下数据分析提示词：\n\n原始提示词：{input}\n',
        "category": "analysis",
        "include_context": True,
        "context_rounds": 5,
        "model_id": "",
    },
    {
        "id": "builtin-translate",
        "name": "翻译提示词优化",
        "system_prompt": '你是"翻译场景的提示词优化专家"。将用户关于翻译的原始提示词优化为专业、精准的翻译指令。\n\n优化要点：\n- 明确源语言和目标语言\n- 指定翻译风格（信达雅/直译/意译）\n- 添加术语一致性要求\n- 仅输出优化后的提示词，不加解释。',
        "user_prompt": '请优化以下翻译提示词：\n\n原始提示词：{input}\n',
        "category": "general",
        "include_context": False,
        "context_rounds": 5,
        "model_id": "",
    },
]

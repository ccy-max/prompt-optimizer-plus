"""Slash command handler for /prompt."""
from __future__ import annotations

import logging
from typing import Optional

from .models import PromptTemplate
from .store import TemplateStore
from .optimizer import PromptOptimizer

logger = logging.getLogger(__name__)

_store: Optional[TemplateStore] = None
_optimizer: Optional[PromptOptimizer] = None


def init_store(store: TemplateStore) -> None:
    global _store
    _store = store


def init_optimizer(optimizer: PromptOptimizer) -> None:
    global _optimizer
    _optimizer = optimizer


async def handle_prompt(args: str, context: dict) -> str:
    """Handle /prompt command.

    Usage:
        /prompt list                    列出所有模板
        /prompt show <id>               查看模板详情
        /prompt optimize <id> <文本>    使用模板优化指定文本
        /prompt delete <id>             删除模板
    """
    if _store is None:
        return "❌ prompt-optimizer-plus store 未初始化"

    args = (args or "").strip()
    parts = args.split(maxsplit=1)
    sub = parts[0].lower() if parts else "list"
    rest = parts[1] if len(parts) > 1 else ""

    if sub in ("list", "ls", ""):
        templates = _store.list_templates()
        if not templates:
            return "📋 暂无模板，请通过面板添加"
        lines = ["📋 提示词模板列表："]
        for t in templates:
            builtin = " (内置)" if t.id.startswith("builtin-") else ""
            model = f" 🤖{t.model_id.split('/')[-1]}" if t.model_id else ""
            lines.append(f"  • [{t.id}] {t.name} ({t.category}{model}){builtin}")
        return "\n".join(lines)

    if sub == "show":
        template = _store.get(rest.strip())
        if template is None:
            return f"❌ 模板 '{rest}' 不存在"
        lines = [
            f"📋 模板：{template.name}",
            f"  ID: {template.id}",
            f"  分类: {template.category}",
            f"  模型: {template.model_id or '默认'}",
            f"  包含上下文: {'是' if template.include_context else '否'}",
            f"  系统提示词: {template.system_prompt[:200]}{'...' if len(template.system_prompt) > 200 else ''}",
            f"  用户提示词: {template.user_prompt[:200]}{'...' if len(template.user_prompt) > 200 else ''}",
        ]
        return "\n".join(lines)

    if sub == "optimize":
        if _optimizer is None:
            return "❌ prompt-optimizer-plus 未初始化"
        # 格式: /prompt optimize <template_id> <user_input>
        opt_parts = rest.strip().split(maxsplit=1)
        if len(opt_parts) < 2:
            return "❌ 用法：/prompt optimize <模板ID> <要优化的文本>"
        template_id = opt_parts[0]
        user_input = opt_parts[1]

        template = _store.get(template_id)
        if template is None:
            return f"❌ 模板 '{template_id}' 不存在"

        result = await _optimizer.optimize(
            system_prompt=template.system_prompt,
            user_prompt=template.user_prompt,
            user_input=user_input,
            model_id=template.model_id,
        )
        if result.optimized_text:
            lines = [
                "✨ 优化完成！",
                f"  模型: {result.model_used}",
                f"  优化结果:",
                result.optimized_text,
            ]
        else:
            lines = ["❌ 优化失败，请检查模型配置"]
        return "\n".join(lines)

    if sub == "delete":
        if _store.delete(rest.strip()):
            return f"✅ 已删除模板 '{rest}'"
        return f"❌ 模板 '{rest}' 不存在或为内置模板不可删除"

    return "❓ 用法：/prompt [list|show|optimize|delete] [参数]"

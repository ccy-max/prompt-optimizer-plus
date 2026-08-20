"""Prompt optimizer core — calls the current model to optimize prompts.

核心逻辑：
1. 模板的 system_prompt 定义"优化专家"角色
2. 模板的 user_prompt 包含变量占位符，注入用户输入/上下文/工具等信息
3. 调用指定模型（或默认模型）
4. 模型直接返回优化后的提示词文本

内置变量（v2.10）：渲染器支持 {{var}} 插值 + {{#var}}/{{^var}} 条件块。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, Optional

from .models import OptimizeResult

logger = logging.getLogger(__name__)

# --- 内置变量名（字母/下划线开头，后续可含字母数字下划线点）---
_VAR_NAME = r"[a-zA-Z_][a-zA-Z0-9_.]*"

# {{#name}}...{{/name}} 条件块（有值才展开）
_SECTION_RE = re.compile(
    rf"\{{\{{\s*#\s*({_VAR_NAME})\s*\}}\}}(.*?)\{{\{{\s*/\s*\1\s*\}}\}}",
    re.DOTALL,
)
# {{^name}}...{{/name}} 反转块（无值才展开）
_INVERTED_RE = re.compile(
    rf"\{{\{{\s*\^\s*({_VAR_NAME})\s*\}}\}}(.*?)\{{\{{\s*/\s*\1\s*\}}\}}",
    re.DOTALL,
)
# {{name}} 变量插值
_VAR_RE = re.compile(rf"\{{\{{\s*({_VAR_NAME})\s*\}}\}}")


def _truthy(value: Any) -> bool:
    """判断变量值是否为「真」：非 None 且非空。"""
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict, tuple, set)):
        return bool(value)
    return bool(value)


def _to_str(value: Any) -> str:
    """把变量值转成字符串；dict/list 序列化为 JSON（紧凑）。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def render_template(template: str, variables: dict) -> str:
    """渲染模板变量。

    支持三种语法：
    - ``{{var}}``      变量插值（已知变量替换为值；未知变量原样保留，
      用于保护模板里作为示例的占位符如 ``{{location_theme}}``）
    - ``{{#var}}...{{/var}}``  条件块：var 有值（非空）才展开
    - ``{{^var}}...{{/var}}``  反转块：var 无值（空）才展开

    条件块会递归渲染内部内容，支持一层嵌套。
    """

    def render(text: str) -> str:
        def section_repl(m: re.Match) -> str:
            name, body = m.group(1), m.group(2)
            if name in variables and _truthy(variables[name]):
                return render(body)
            return ""

        def inverted_repl(m: re.Match) -> str:
            name, body = m.group(1), m.group(2)
            if name not in variables or not _truthy(variables[name]):
                return render(body)
            return ""

        text = _SECTION_RE.sub(section_repl, text)
        text = _INVERTED_RE.sub(inverted_repl, text)

        def var_repl(m: re.Match) -> str:
            name = m.group(1)
            if name in variables:
                return _to_str(variables[name])
            return m.group(0)  # 未知变量原样保留

        return _VAR_RE.sub(var_repl, text)

    return render(template)


def _extract_text_from_content(content: Any) -> str:
    """Extract plain text from agentscope 2.0 Msg content (list of blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif hasattr(block, "text"):
                parts.append(block.text)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "".join(parts)
    if hasattr(content, "text"):
        return content.text
    return str(content)


class PromptOptimizer:
    """Calls the current session's model to optimize prompts."""

    async def optimize(
        self,
        system_prompt: str,
        user_prompt: str,
        user_input: str,
        model_id: str = "",
        variables: Optional[dict] = None,
    ) -> OptimizeResult:
        """Execute prompt optimization.

        Args:
            system_prompt: 模板的系统提示词（优化专家角色定义）
            user_prompt: 模板的用户提示词（含变量占位符）
            user_input: 用户在输入框中输入的原始文本
            model_id: 指定模型 ID，空则使用默认模型
            variables: 内置变量映射（originalPrompt/userQuestion/conversationContext/toolsContext 等）
        """
        # --- 组装内置变量（routes 已传的优先，缺省回退到 user_input）---
        vars_map: dict = dict(variables or {})
        for key in ("originalPrompt", "userQuestion", "currentPrompt", "iterateInput"):
            if key not in vars_map or not vars_map[key]:
                vars_map[key] = user_input

        # --- 渲染模板变量（{{var}} / 条件块）---
        final_system_prompt = render_template(system_prompt, vars_map)
        final_user_prompt = render_template(user_prompt, vars_map)

        # 向后兼容旧模板的单花括号 {input} 占位符
        final_user_prompt = final_user_prompt.replace("{input}", user_input)
        final_system_prompt = final_system_prompt.replace("{input}", user_input)

        try:
            # --- 获取模型实例 ---
            # model_id 格式: "provider_id/model_id" 或 "provider_id:model_id"
            model = None
            model_name = ""

            # 方式1: 使用 create_model_and_formatter（与 title_generator 一致）
            try:
                from qwenpaw.agents.model_factory import create_model_and_formatter
                slot_override = None
                if model_id:
                    # 转换 "provider/model" → "provider:model" 格式
                    slot_override = model_id.replace("/", ":", 1)
                model, _ = create_model_and_formatter(model_slot_override=slot_override)
                if model:
                    model_name = model_id or "default"
            except Exception:
                pass  # 方式1失败则走方式2

            # 方式2: fallback 到 ProviderManager（不指定模型，用活跃模型）
            if model is None and not model_id:
                try:
                    from qwenpaw.providers.provider_manager import ProviderManager
                    pm = ProviderManager.get_instance()
                    model = pm.get_active_chat_model()
                    slot = pm.get_active_model()
                    if slot:
                        model_name = getattr(slot, "model", "") or "active"
                except Exception:
                    pass  # 两种方式都失败则返回空结果

            if model is None:
                return OptimizeResult(
                    original_input=user_input,
                    optimized_text="",
                    template_name="",
                    model_used="",
                )

            # --- 构造 Msg 对象（agentscope 2.0 要求）---
            from agentscope.message import Msg, TextBlock

            messages = [
                Msg(
                    name="system",
                    role="system",
                    content=[TextBlock(type="text", text=final_system_prompt)],
                ),
                Msg(
                    name="user",
                    role="user",
                    content=[TextBlock(type="text", text=final_user_prompt)],
                ),
            ]

            # --- 调用模型 ---
            response_text = ""
            try:
                from qwenpaw.utils.model_response import consume_model_response
                response_text = await asyncio.wait_for(
                    consume_model_response(model, messages),
                    timeout=60,
                )
            except ImportError:
                # fallback: 直接调用 model
                response = await model(messages=messages)
                response_text = _extract_text_from_content(
                    getattr(response, "content", response)
                )

            if not response_text:
                return OptimizeResult(
                    original_input=user_input,
                    optimized_text="",
                    template_name="",
                    model_used=model_name,
                )

            return OptimizeResult(
                original_input=user_input,
                optimized_text=response_text.strip(),
                template_name="",
                model_used=model_name,
            )

        except Exception as exc:
            logger.error("[prompt-optimizer-plus] optimization failed: %s", exc, exc_info=True)
            return OptimizeResult(
                original_input=user_input,
                optimized_text="",
                template_name="",
                model_used="",
            )

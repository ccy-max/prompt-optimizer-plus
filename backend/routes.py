"""HTTP API routes for prompt-optimizer-plus plugin."""
from __future__ import annotations

import logging
import time as _time
from typing import Optional, List
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from .models import PromptTemplate, OptimizeResult
from .store import TemplateStore, SettingsStore
from .variable_store import VariableStore
from .optimizer import PromptOptimizer, render_template
from .project_store import ProjectStore

logger = logging.getLogger(__name__)

router = APIRouter()

_store: Optional[TemplateStore] = None
_settings_store: Optional[SettingsStore] = None
_variable_store: Optional[VariableStore] = None
_optimizer: Optional[PromptOptimizer] = None
_project_store: Optional[ProjectStore] = None

# v1.3.0: _fetch_tools 进程级缓存，避免每次优化都调用 load_agent_config
_tools_cache: dict[str, tuple[float, list]] = {}
_TOOLS_CACHE_TTL = 30  # 秒


def init_store(store: TemplateStore) -> None:
    global _store
    _store = store


def init_settings_store(settings_store: SettingsStore) -> None:
    global _settings_store
    _settings_store = settings_store


def init_variable_store(variable_store: VariableStore) -> None:
    global _variable_store
    _variable_store = variable_store


def init_optimizer(optimizer: PromptOptimizer) -> None:
    global _optimizer
    _optimizer = optimizer


def init_project_store(project_store: ProjectStore) -> None:
    global _project_store
    _project_store = project_store


def _get_project_store() -> ProjectStore:
    if _project_store is None:
        raise HTTPException(503, "prompt-optimizer-plus project store not initialised")
    return _project_store


def _get_store() -> TemplateStore:
    if _store is None:
        raise HTTPException(503, "prompt-optimizer-plus store not initialised")
    return _store


def _get_settings_store() -> SettingsStore:
    if _settings_store is None:
        raise HTTPException(503, "prompt-optimizer-plus settings store not initialised")
    return _settings_store


def _get_variable_store() -> VariableStore:
    if _variable_store is None:
        raise HTTPException(503, "prompt-optimizer-plus variable store not initialised")
    return _variable_store


def _get_optimizer() -> PromptOptimizer:
    if _optimizer is None:
        raise HTTPException(503, "prompt-optimizer-plus not initialised")
    return _optimizer


# --- Request/Response Models ---

class TemplateCreateBody(BaseModel):
    name: str
    system_prompt: str = ""
    user_prompt: str = "{input}"
    category: str = "general"
    include_context: bool = False
    context_rounds: int = 5
    model_id: str = ""


class TemplateUpdateBody(BaseModel):
    name: Optional[str] = None
    system_prompt: Optional[str] = None
    user_prompt: Optional[str] = None
    category: Optional[str] = None
    include_context: Optional[bool] = None
    context_rounds: Optional[int] = None
    model_id: Optional[str] = None


class ReorderBody(BaseModel):
    """模板排序请求：按数组顺序，下标越小越靠前。"""
    template_ids: List[str]


class ImportBody(BaseModel):
    """导入配置：模板列表 + 设置 + 自定义变量。模板的 model_id 导入时置空。"""
    templates: List[dict] = []
    settings: dict = {}
    variables: List[dict] = []


class OptimizeBody(BaseModel):
    """优化请求：前端传入用户输入 + 模板 ID，后端注入变量后调用模型。"""
    user_input: str = ""          # 本次要优化的输入（第一轮=原始，迭代=上一轮结果）
    template_id: Optional[str] = None
    model_id: str = ""            # 可选，覆盖模板的模型设置
    include_context: bool = False
    context_rounds: int = 5
    # 迭代/状态相关变量（v2.11，可选；缺省时回退为 user_input）
    original_prompt: str = ""     # 用户最初的原始提示词（迭代时保持不变，供 {{originalPrompt}}）
    last_optimized_prompt: str = ""
    current_prompt: str = ""
    iterate_input: str = ""


class PendingBody(BaseModel):
    optimized_text: str = ""
    template_name: str = ""
    model_used: str = ""


class VariableCreateBody(BaseModel):
    """新建/更新自定义变量。value 支持多行文本。"""
    name: str
    label: str = ""
    value: str = ""
    description: str = ""


# --- Variables (自定义变量 CRUD) ---

@router.get("/variables")
async def list_variables():
    vs = _get_variable_store()
    return {"variables": vs.list_variables()}


@router.post("/variables", status_code=201)
async def create_variable(body: VariableCreateBody):
    vs = _get_variable_store()
    try:
        var = vs.create(body.name, body.value, body.description, body.label)
        return {"ok": True, "variable": var}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.put("/variables/{var_id}")
async def update_variable(var_id: str, body: VariableCreateBody):
    vs = _get_variable_store()
    try:
        var = vs.update(var_id, body.name, body.value, body.description, body.label)
        if var is None:
            raise HTTPException(404, "Variable not found")
        return {"ok": True, "variable": var}
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/variables/{var_id}")
async def delete_variable(var_id: str):
    vs = _get_variable_store()
    if not vs.delete(var_id):
        raise HTTPException(404, "Variable not found")
    return {"ok": True}


# --- Template CRUD ---

@router.get("/templates")
async def list_templates():
    store = _get_store()
    templates = store.list_templates()
    return {"templates": [t.to_dict() for t in templates]}


@router.post("/templates", status_code=201)
async def create_template(body: TemplateCreateBody):
    store = _get_store()
    template = PromptTemplate(
        name=body.name,
        system_prompt=body.system_prompt,
        user_prompt=body.user_prompt,
        category=body.category,
        include_context=body.include_context,
        context_rounds=body.context_rounds,
        model_id=body.model_id,
    )
    created = store.create(template)
    return {"ok": True, "template": created.to_dict()}


@router.post("/templates/reorder")
async def reorder_templates(body: ReorderBody):
    """按前端传入的 id 顺序持久化模板排序。"""
    store = _get_store()
    if not body.template_ids:
        return {"ok": True}
    store.reorder(body.template_ids)
    return {"ok": True}


# --- 导出 / 导入配置 ---

@router.get("/export")
async def export_config():
    """导出配置为 JSON（模板 + 设置 + 自定义变量，不带模型配置 model_id）。"""
    store = _get_store()
    settings_store = _get_settings_store()
    templates = store.list_templates()
    settings = settings_store.get()

    variables = []
    try:
        variables = [
            {"name": v["name"], "label": v.get("label", ""), "value": v.get("value", ""), "description": v.get("description", "")}
            for v in _get_variable_store().list_variables()
        ]
    except Exception:
        pass

    return {
        "format": "prompt-optimizer-plus-export",
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "templates": [
            {
                "name": t.name,
                "system_prompt": t.system_prompt,
                "user_prompt": t.user_prompt,
                "category": t.category,
                "include_context": t.include_context,
                "context_rounds": t.context_rounds,
            }
            for t in templates
        ],
        "settings": {
            "include_context": settings.get("include_context", False),
            "context_rounds": settings.get("context_rounds", 5),
        },
        "variables": variables,
    }


@router.post("/import")
async def import_config(body: ImportBody):
    """从 JSON 导入模板与设置（模板的 model_id 置空，避免带入环境相关配置）。"""
    store = _get_store()
    settings_store = _get_settings_store()

    imported = 0
    for tpl_data in body.templates:
        if not isinstance(tpl_data, dict) or not str(tpl_data.get("name", "")).strip():
            continue
        try:
            context_rounds = int(tpl_data.get("context_rounds", 5))
        except (TypeError, ValueError):
            context_rounds = 5
        template = PromptTemplate(
            name=str(tpl_data.get("name", "")).strip(),
            system_prompt=tpl_data.get("system_prompt", "") or "",
            user_prompt=tpl_data.get("user_prompt", "") or "{input}",
            category=tpl_data.get("category", "") or "general",
            include_context=bool(tpl_data.get("include_context", False)),
            context_rounds=context_rounds,
            model_id="",  # 导入不带模型配置
        )
        store.create(template)
        imported += 1

    # 导入设置（仅 include_context / context_rounds，不带 model_id）
    if isinstance(body.settings, dict):
        settings_update = {}
        if "include_context" in body.settings:
            settings_update["include_context"] = bool(body.settings["include_context"])
        if "context_rounds" in body.settings:
            try:
                settings_update["context_rounds"] = int(body.settings["context_rounds"])
            except (TypeError, ValueError):
                pass
        if settings_update:
            settings_store.update(settings_update)

    # 导入自定义变量
    imported_vars = 0
    try:
        vs = _get_variable_store()
        for var_data in (body.variables if isinstance(body.variables, list) else []):
            if not isinstance(var_data, dict):
                continue
            vname = str(var_data.get("name", "")).strip()
            if not vname:
                continue
            try:
                vs.create(vname,
                          str(var_data.get("value", "")),
                          str(var_data.get("description", "")),
                          str(var_data.get("label", "")))
                imported_vars += 1
            except ValueError:
                pass  # 变量名冲突或保留名，跳过
    except Exception:
        pass

    return {"ok": True, "imported": imported, "imported_variables": imported_vars}


@router.get("/templates/{template_id}")
async def get_template(template_id: str):
    store = _get_store()
    template = store.get(template_id)
    if template is None:
        raise HTTPException(404, "Template not found")
    return {"template": template.to_dict()}


@router.put("/templates/{template_id}")
async def update_template(template_id: str, body: TemplateUpdateBody):
    store = _get_store()
    existing = store.get(template_id)
    if existing is None:
        raise HTTPException(404, "Template not found")

    if body.name is not None:
        existing.name = body.name
    if body.system_prompt is not None:
        existing.system_prompt = body.system_prompt
    if body.user_prompt is not None:
        existing.user_prompt = body.user_prompt
    if body.category is not None:
        existing.category = body.category
    if body.include_context is not None:
        existing.include_context = body.include_context
    if body.context_rounds is not None:
        existing.context_rounds = body.context_rounds
    if body.model_id is not None:
        existing.model_id = body.model_id

    updated = store.update(template_id, existing)
    return {"ok": True, "template": updated.to_dict() if updated else None}


@router.delete("/templates/{template_id}")
async def delete_template(template_id: str):
    store = _get_store()
    if not store.delete(template_id):
        raise HTTPException(404, "Template not found or cannot be deleted (built-in)")
    return {"ok": True}


# --- Models (获取可用模型列表) ---

def _provider_effective(p) -> bool:
    """判断 provider 是否有效（激活/可用）。

    满足任一条件即视为有效：
    - 已配置 API Key
    - 本地 provider（is_local，无需 key，如 Ollama / LMStudio）
    - 免费 tier（is_free_tier）
    - OAuth 已连接
    """
    if str(getattr(p, "api_key", "") or "").strip():
        return True
    if getattr(p, "is_local", False):
        return True
    if getattr(p, "is_free_tier", False):
        return True
    if getattr(p, "supports_oauth", False) and getattr(p, "oauth_connected", False):
        return True
    return False


@router.get("/models")
async def list_models():
    """获取系统配置的可用模型列表，供前端选择。"""
    try:
        from qwenpaw.providers.provider_manager import ProviderManager
        pm = ProviderManager.get_instance()
        slot = pm.get_active_model()
        active_model = getattr(slot, "model", "") if slot else ""
        active_provider = getattr(slot, "provider_id", "") if slot else ""
        models = []

        # 使用 list_provider_info 获取所有 provider 和模型
        try:
            providers = await pm.list_provider_info()
        except Exception:
            providers = []

        for p in providers:
            # 只保留有效 provider：已配置 API Key / 本地 / 免费 tier / OAuth 已连接
            if not _provider_effective(p):
                continue
            provider_id = getattr(p, "id", "")
            provider_name = getattr(p, "name", provider_id)
            # 合并 models + extra_models
            all_models = list(getattr(p, "models", []) or []) + list(getattr(p, "extra_models", []) or [])
            if not all_models:
                continue  # 无可用模型的 provider 无意义
            for m in all_models:
                model_id = getattr(m, "id", str(m))
                model_name = getattr(m, "name", model_id)
                is_active = (model_id == active_model and provider_id == active_provider)
                models.append({
                    "id": f"{provider_id}/{model_id}",
                    "name": model_name or model_id,
                    "provider": provider_id,
                    "provider_name": provider_name,
                    "is_active": is_active,
                    "is_free": getattr(m, "is_free", False),
                })

        # 如果没拿到模型，至少返回当前活跃模型
        if not models and slot:
            models.append({
                "id": f"{active_provider}/{active_model}",
                "name": active_model,
                "provider": active_provider,
                "provider_name": "",
                "is_active": True,
                "is_free": False,
            })

        return {"models": models}
    except Exception as exc:
        logger.error("[prompt-optimizer-plus] list models failed: %s", exc)
        return {"models": []}


# --- Optimize ---

@router.post("/optimize")
async def optimize_prompt(body: OptimizeBody, request: Request):
    """执行提示词优化：用模板的 system/user prompt + 用户输入 → 调用模型 → 返回优化结果。"""
    optimizer = _get_optimizer()
    store = _get_store()

    system_prompt = ""
    user_prompt = "{input}"
    template_name = ""
    model_id = body.model_id
    include_context = body.include_context
    context_rounds = body.context_rounds

    if body.template_id:
        template = store.get(body.template_id)
        if template is None:
            raise HTTPException(404, f"Template '{body.template_id}' not found")
        system_prompt = template.system_prompt
        user_prompt = template.user_prompt
        template_name = template.name
        include_context = template.include_context or body.include_context
        context_rounds = template.context_rounds or body.context_rounds
        # 模板的 model_id 优先，请求的 model_id 次之
        if template.model_id and not model_id:
            model_id = template.model_id

    if not body.user_input:
        raise HTTPException(400, "user_input is required")

    # --- 收集内置变量（v2.10）---
    context_data = None
    if include_context:
        context_data = await _fetch_context(request, context_rounds)

    tools_data = await _fetch_tools(request)

    # v1.4.0: 项目感知 — 从设置开关与深度拉取当前项目信息（带缓存）
    project_data = None
    _sett = _get_settings_store().get()
    include_project = bool(_sett.get("include_project", True))
    project_depth = int(_sett.get("project_depth", 2) or 2)
    if include_project:
        try:
            project_data = await _fetch_project_info(request, project_depth)
        except Exception as exc:
            logger.warning("[prompt-optimizer-plus] project context failed: %s", exc)
            project_data = None

    variables = {
        # originalPrompt / userQuestion 指向「最初输入」；迭代时由前端保持 original_prompt 不变
        "originalPrompt": body.original_prompt or body.user_input,
        "userQuestion": body.original_prompt or body.user_input,
        "currentPrompt": body.current_prompt or body.user_input,
        "iterateInput": body.iterate_input or body.user_input,
        "conversationContext": context_data,
        "toolsContext": tools_data,
        "lastOptimizedPrompt": body.last_optimized_prompt,
        "projectContext": project_data,
    }

    # 合并用户自定义变量（内置变量不被覆盖）
    try:
        for vname, vval in _get_variable_store().get_all_as_map().items():
            if vname not in variables:
                variables[vname] = vval
    except Exception:
        pass  # variable store 未初始化时不影响优化

    result = await optimizer.optimize(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        user_input=body.user_input,
        model_id=model_id,
        variables=variables,
    )
    result.template_name = template_name

    # v1.3.2: 返回渲染后的提示词和自定义变量，供前端"请求详情"弹窗展示
    from .optimizer import render_template
    _debug_vars = dict(variables)
    for key in ("originalPrompt", "userQuestion", "currentPrompt", "iterateInput"):
        if key not in _debug_vars or not _debug_vars[key]:
            _debug_vars[key] = body.user_input
    _debug_system = render_template(system_prompt, _debug_vars)
    _debug_user = render_template(user_prompt, _debug_vars)
    _debug_system = _debug_system.replace("{input}", body.user_input)
    _debug_user = _debug_user.replace("{input}", body.user_input)

    _custom_vars = {}
    try:
        _custom_vars = _get_variable_store().get_all_as_map()
    except Exception:
        pass

    return {
        "ok": True,
        "result": result.to_dict(),
        "debug": {
            "rendered_system_prompt": _debug_system,
            "rendered_user_prompt": _debug_user,
            "custom_variables": _custom_vars,
            "project_info": project_data,  # v1.4.0: 项目感知注入结果
        },
    }


# --- Session Pending Results ---

@router.get("/sessions/{session_id}/pending")
async def get_pending(session_id: str):
    store = _get_store()
    result = store.get_pending(session_id)
    if result is None:
        return {"pending": None}
    return {"pending": result}


@router.put("/sessions/{session_id}/pending")
async def set_pending(session_id: str, body: PendingBody):
    store = _get_store()
    store.set_pending(session_id, body.model_dump())
    return {"ok": True}


@router.delete("/sessions/{session_id}/pending")
async def clear_pending(session_id: str):
    store = _get_store()
    store.clear_pending(session_id)
    return {"ok": True}


# --- Settings (持久化到插件目录的 settings.json) ---

class SettingsBody(BaseModel):
    model_id: Optional[str] = None
    include_context: Optional[bool] = None
    context_rounds: Optional[int] = None
    ctx_trunc_head: Optional[bool] = None
    ctx_trunc_middle: Optional[bool] = None
    ctx_trunc_tail: Optional[bool] = None
    ctx_trunc_head_b: Optional[int] = None
    ctx_trunc_middle_b: Optional[int] = None
    ctx_trunc_tail_b: Optional[int] = None
    ctx_trunc_unit: Optional[str] = None
    ctx_trunc_marker: Optional[bool] = None
    include_project: Optional[bool] = None
    project_depth: Optional[int] = None


@router.get("/settings")
async def get_settings():
    """获取持久化的插件设置。"""
    ss = _get_settings_store()
    return {"settings": ss.get()}


@router.put("/settings")
async def update_settings(body: SettingsBody):
    """更新插件设置，持久化到 settings.json。"""
    ss = _get_settings_store()
    updated = ss.update(body.model_dump(exclude_none=True))
    return {"ok": True, "settings": updated}


# --- Context truncation (v1.3.4) ---

def _estimate_tokens(text: str) -> int:
    """粗略 token 估算：CJK 1字≈1 token，Latin 4字≈1 token。"""
    cjk = sum(1 for c in text if '\u4e00' <= c <= '\u9fff' or '\u3040' <= c <= '\u30ff')
    other = len(text) - cjk
    return cjk + max(0, other // 4)


def _truncate_content(content: str, cfg: dict) -> str:
    """按截取设置裁剪单条消息内容。

    cfg 包含: ctx_trunc_head/middle/tail(bool), *_b(int), ctx_trunc_unit, ctx_trunc_marker
    """
    msg_len = len(content)
    if msg_len == 0:
        return content

    head_on = cfg.get("ctx_trunc_head", True)
    mid_on = cfg.get("ctx_trunc_middle", False)
    tail_on = cfg.get("ctx_trunc_tail", True)
    head_b = cfg.get("ctx_trunc_head_b", 500)
    mid_b = cfg.get("ctx_trunc_middle_b", 1000)
    tail_b = cfg.get("ctx_trunc_tail_b", 500)
    unit = cfg.get("ctx_trunc_unit", "char")
    marker = cfg.get("ctx_trunc_marker", True)

    # token 模式：将 token 预算转为字符预算（×2.5 系数）
    if unit == "token":
        head_b = int(head_b * 2.5)
        mid_b = int(mid_b * 2.5) if mid_b else 0
        tail_b = int(tail_b * 2.5)

    total = (head_b if head_on else 0) + (mid_b if mid_on else 0) + (tail_b if tail_on else 0)
    if msg_len <= total:
        return content  # 预算够，不截取

    marker_str = "...(已截断)..." if marker else "..."
    head_end = head_b if head_on else 0
    tail_start = msg_len - tail_b if tail_on else msg_len

    if mid_on:
        if head_on:
            mid_start = head_end
        elif tail_on:
            mid_start = max(0, (tail_start - mid_b) // 2)
        else:
            mid_start = max(0, (msg_len - mid_b) // 2)
        mid_end = min(mid_start + mid_b, tail_start)
    else:
        mid_start = mid_end = head_end

    # 构建 segments
    parts = []
    prev_end = 0

    if head_on:
        parts.append(content[:head_b])
        prev_end = head_b

    if mid_on and mid_end > mid_start:
        if mid_start > prev_end:
            parts.append("GAP")
        parts.append(content[mid_start:mid_end])
        prev_end = mid_end

    if tail_on:
        if tail_start > prev_end:
            parts.append("GAP")
        parts.append(content[tail_start:])
        prev_end = msg_len

    if prev_end < msg_len:
        parts.append("GAP")

    return "".join(marker_str if p == "GAP" else p for p in parts)


# --- Helpers ---

async def _fetch_context(request: Request, rounds: int):
    """从当前请求的 session 取上下文（JSON 消息数组，空则 None）。"""
    session_id = request.headers.get("X-Session-Id", "")
    if not session_id:
        return None
    return await _fetch_context_by_session(request, session_id, rounds)


async def _fetch_context_by_session(request: Request, session_id: str, rounds: int):
    """从会话历史取最近对话，返回 JSON 消息数组 [{role, content}, ...]。

    历史存储在 scroll 的 conversation_history SQLite（workspace_dir/history.db），
    通过 MemorySpace 只读查询，过滤 context_msg（用户消息）与
    model_turn（助手回复）两类，其余（tool_result 等）跳过。

    v1.3.3 修复：ms.session() 用 ORDER BY seq LIMIT 返回的是**最早的** N 条，
    不是最近的。改用 ORDER BY seq DESC 拿最新 N 条再翻转，确保拿到的是
    "最近"的对话上下文。
    """
    try:
        from qwenpaw.app.agent_context import get_agent_for_request
        from qwenpaw.agents.context.scroll.memoryspace import MemorySpace

        workspace = await get_agent_for_request(request)
        history_db_path = workspace.workspace_dir / "history.db"
        if not history_db_path.exists():
            return None

        ms = MemorySpace(
            history_db_path=str(history_db_path),
            session_id=session_id,
            agent_id=workspace.agent_id,
        )
        try:
            # v1.3.3: WHERE kind IN (...) 直接过滤，确保 LIMIT 拿到的都是
            # 用户/助手消息，不会被 tool_result 占满配额
            rows = ms._select(
                "SELECT seq, kind, role, name, headline, content, created_at "
                "FROM hist.conversation_history "
                "WHERE session_id = ? AND agent_id = ? "
                "AND kind IN ('context_msg', 'model_turn') "
                "ORDER BY seq DESC LIMIT ?",
                (str(session_id), str(workspace.agent_id), int(rounds * 2)),
            )
            rows.reverse()  # 最新 → 正序（老→新）
        finally:
            ms.close()

        items = []
        # v1.3.4: 读取截取设置
        try:
            trunc_cfg = _get_settings_store().get()
        except Exception:
            trunc_cfg = {}
        for row in rows:
            content = row.get("content") or ""
            if not content:
                continue
            role = row.get("role") or "unknown"
            # v1.3.4: 按用户设置截取（默认均衡：头500+尾500）
            truncated = _truncate_content(str(content), trunc_cfg)
            items.append({"role": role, "content": truncated})

        return items or None
    except Exception as exc:
        return None


async def _fetch_tools(request: Request):
    """获取当前 agent 的可用工具列表 [{name, description, enabled}, ...]。

    复用 QwenPaw 内置 /tools list_tools 的取数逻辑（get_agent_for_request +
    load_agent_config），只提取 name/description/enabled 三字段注入 toolsContext。
    v1.3.0: 加 30 秒 TTL 进程级缓存，避免每次优化都调用 load_agent_config。
    """
    try:
        from qwenpaw.app.agent_context import get_agent_for_request

        workspace = await get_agent_for_request(request)
        cache_key = workspace.agent_id

        # 检查缓存
        now = _time.monotonic()
        cached = _tools_cache.get(cache_key)
        if cached is not None:
            ts, data = cached
            if now - ts < _TOOLS_CACHE_TTL:
                return data or None

        from qwenpaw.config.config import load_agent_config
        from qwenpaw.config import load_config as load_global_config

        agent_config = load_agent_config(cache_key)

        if not agent_config.tools or not agent_config.tools.builtin_tools:
            global_cfg = load_global_config()
            tools_config = global_cfg.tools if hasattr(global_cfg, "tools") else None
            if not tools_config:
                _tools_cache[cache_key] = (now, [])
                return None
            builtin_tools = tools_config.builtin_tools
        else:
            builtin_tools = agent_config.tools.builtin_tools

        items = []
        for name, tool_cfg in builtin_tools.items():
            items.append({
                "name": name,
                "description": (getattr(tool_cfg, "description", "") or "").strip(),
                "enabled": bool(getattr(tool_cfg, "enabled", True)),
            })
        _tools_cache[cache_key] = (now, items)
        return items or None
    except Exception as exc:
        return None
# --- Project awareness (v1.4.0) ---

async def _fetch_project_info(request: Request, depth: int = 2, force: bool = False):
    """解析当前项目目录并返回项目信息（带签名缓存）。

    复用 QwenPaw 官方 get_project_dir_for_request：session override > agent config > workspace fallback。
    """
    from qwenpaw.app.agent_context import get_agent_for_request, get_project_dir_for_request

    workspace = await get_agent_for_request(request)
    project_dir = await get_project_dir_for_request(request, workspace)
    project_store = _get_project_store()
    info = project_store.get_project_info(project_dir, depth=depth, force=force)
    # 附加来源便于前端展示
    info = dict(info)
    info["resolved_dir"] = str(project_dir)
    return info


@router.get("/project-info")
async def get_project_info(request: Request, refresh: int = Query(0)):
    """返回当前项目识别结果（前端设置弹窗预览 / 调试用）。refresh=1 强制重扫。"""
    _sett = _get_settings_store().get()
    depth = int(_sett.get("project_depth", 2) or 2)
    try:
        info = await _fetch_project_info(request, depth=depth, force=bool(refresh))
        return {"ok": True, "project": info}
    except Exception as exc:
        return {"ok": False, "project": None, "error": str(exc)}


@router.post("/project/rescan")
async def rescan_project(request: Request):
    """强制重新扫描当前项目并返回结果。"""
    _sett = _get_settings_store().get()
    depth = int(_sett.get("project_depth", 2) or 2)
    try:
        info = await _fetch_project_info(request, depth=depth, force=True)
        return {"ok": True, "project": info}
    except Exception as exc:
        return {"ok": False, "project": None, "error": str(exc)}
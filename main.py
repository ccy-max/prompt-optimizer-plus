"""prompt-optimizer-plus plugin entry point.

Registers:
- HTTP routes  (/api/prompt-optimizer-plus/*)
- on_reasoning middleware (inject optimized prompts)
- /prompt slash command
- Settings persistence (settings.json in plugin dir)
"""
from __future__ import annotations

import logging
from pathlib import Path

from qwenpaw.plugins.api import PluginApi
from qwenpaw.constant import WORKING_DIR

from .backend.store import TemplateStore, SettingsStore
from .backend.variable_store import VariableStore
from .backend.optimizer import PromptOptimizer
from .backend.middleware import PromptInjectMiddleware
from .backend.project_store import ProjectStore
from .backend.routes import (
    router,
    init_store as init_routes_store,
    init_settings_store as init_routes_settings,
    init_variable_store as init_routes_variable,
    init_optimizer as init_routes_optimizer,
    init_project_store as init_routes_project,
)
from .backend.commands import (
    handle_prompt,
    init_store as init_cmds_store,
    init_optimizer as init_cmds_optimizer,
)

logger = logging.getLogger(__name__)

# 持久化数据目录：放在 WORKING_DIR 下，避免 `qwenpaw plugin install --force`
# 删除插件目录（plugins/<id>/）时连带清空用户数据。
_DATA_DIR = Path(WORKING_DIR) / "plugin_data" / "prompt-optimizer-plus"

# 旧 id（prompt-optimizer）数据目录，用于一次性迁移
_LEGACY_ID_DATA_DIR = Path(WORKING_DIR) / "plugin_data" / "prompt-optimizer"
_LEGACY_ID_STORE_PATH = _LEGACY_ID_DATA_DIR / "templates.json"
_LEGACY_ID_SETTINGS_PATH = _LEGACY_ID_DATA_DIR / "settings.json"

# 旧数据位置（插件目录内），用于一次性迁移
_LEGACY_STORE_PATH = Path(__file__).resolve().parent / "templates.json"
_LEGACY_SETTINGS_PATH = Path(__file__).resolve().parent / "settings.json"

_STORE_PATH = _DATA_DIR / "templates.json"
_SETTINGS_PATH = _DATA_DIR / "settings.json"
_VARIABLES_PATH = _DATA_DIR / "variables.json"
_PROJECT_CACHE_PATH = _DATA_DIR / "project_cache.json"  # v1.4.0: 项目感知缓存


def _migrate_legacy_data() -> None:
    """迁移旧数据到持久化目录（仅当目标不存在时）。

    1) 旧 id（prompt-optimizer）持久化目录 → 新 id（prompt-optimizer-plus）目录
    2) 插件目录内的旧数据 → 新持久化目录
    """
    _DATA_DIR.mkdir(parents=True, exist_ok=True)
    for legacy, target in (
        (_LEGACY_ID_STORE_PATH, _STORE_PATH),
        (_LEGACY_ID_SETTINGS_PATH, _SETTINGS_PATH),
    ):
        try:
            if legacy.exists() and not target.exists():
                legacy.replace(target)
                logger.info("migrated legacy-id data %s -> %s", legacy, target)
        except Exception as exc:  # pragma: no cover - best effort
            logger.warning("failed to migrate legacy-id data %s: %s", legacy, exc)
    for legacy, target in (
        (_LEGACY_STORE_PATH, _STORE_PATH),
        (_LEGACY_SETTINGS_PATH, _SETTINGS_PATH),
    ):
        try:
            if legacy.exists() and not target.exists():
                legacy.replace(target)
                logger.info("migrated %s -> %s", legacy, target)
        except Exception as exc:  # pragma: no cover - best effort
            logger.warning("failed to migrate %s: %s", legacy, exc)


class Plugin:
    """Prompt Optimizer Plus plugin main class."""

    def register(self, api: PluginApi) -> None:
        _migrate_legacy_data()

        store = TemplateStore(_STORE_PATH)
        settings_store = SettingsStore(_SETTINGS_PATH)
        variable_store = VariableStore(_VARIABLES_PATH)
        project_store = ProjectStore(_PROJECT_CACHE_PATH)
        optimizer = PromptOptimizer()

        init_routes_store(store)
        init_routes_settings(settings_store)
        init_routes_variable(variable_store)
        init_routes_project(project_store)
        init_routes_optimizer(optimizer)
        init_cmds_store(store)
        init_cmds_optimizer(optimizer)

        # HTTP API
        api.register_http_router(
            router, prefix="/prompt-optimizer-plus", tags=["prompt-optimizer-plus"],
        )

        # Middleware factory: called per-request during agent assembly
        def _middleware_factory(ctx, agent_config):
            return PromptInjectMiddleware(store)

        api.register_middleware(_middleware_factory, priority=60)

        # Slash command
        api.register_slash_command(
            name="prompt",
            handler=handle_prompt,
            category="plugin",
            help_text="提示词优化: /prompt [list|show|optimize|apply|delete] [id]",
        )

        logger.info("prompt-optimizer-plus v1.4.1 registered")


plugin = Plugin()

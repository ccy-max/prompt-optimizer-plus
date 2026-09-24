"""Atomic JSON template store for prompt-optimizer-plus."""
from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Optional, List

from .models import PromptTemplate, BUILTIN_TEMPLATES

_LOCK = threading.Lock()


class TemplateStore:
    """Persist prompt templates to a JSON file."""

    def __init__(self, path: str | Path | None = None):
        if path is None:
            path = Path(__file__).resolve().parent.parent / "templates.json"
        self._path = Path(path)
        self._data: dict[str, dict] = {}
        self._pending: dict[str, dict] = {}  # v1.3.0: 纯内存，不落盘
        self._load()
        self._ensure_builtins()

    def _load(self) -> None:
        try:
            if self._path.exists():
                with open(self._path, "r", encoding="utf-8") as f:
                    self._data = json.load(f)
        except Exception:
            self._data = {}

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(self._path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self._data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, str(self._path))
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def _ensure_builtins(self) -> None:
        """Insert built-in templates if they don't exist yet (and weren't deleted).

        创建/补齐时用 PromptTemplate 规范生成 created_at/updated_at，
        避免每次 from_dict 因缺失时间戳重新生成导致返回数据不稳定。
        """
        changed = False
        deleted = self._data.get("_deleted_builtins", [])
        if not isinstance(deleted, list):
            deleted = []
        for idx, bt in enumerate(BUILTIN_TEMPLATES):
            bid = bt["id"]
            if bid in deleted:
                continue  # 用户已删除，不重建
            if bid not in self._data:
                tpl = PromptTemplate.from_dict(dict(bt))
                tpl.sort_order = idx
                self._data[bid] = tpl.to_dict()
                changed = True
            else:
                existing = self._data[bid]
                if isinstance(existing, dict):
                    need_fix = False
                    if "sort_order" not in existing:
                        existing["sort_order"] = idx
                        need_fix = True
                    if not existing.get("created_at") or not existing.get("updated_at"):
                        fixed = PromptTemplate.from_dict(existing).to_dict()
                        existing.update(fixed)
                        need_fix = True
                    if need_fix:
                        changed = True
        if changed:
            self._save()

    # --- CRUD ---

    def list_templates(self) -> List[PromptTemplate]:
        with _LOCK:
            result = []
            for v in self._data.values():
                if not isinstance(v, dict):
                    continue
                if v.get("id", "").startswith("_pending:"):
                    continue
                result.append(PromptTemplate.from_dict(v))
            result.sort(key=lambda t: (t.sort_order, t.created_at))
            return result

    def get(self, template_id: str) -> Optional[PromptTemplate]:
        with _LOCK:
            raw = self._data.get(template_id)
            if raw is None:
                return None
            return PromptTemplate.from_dict(raw)

    def _next_sort_order(self) -> int:
        max_order = -1
        for v in self._data.values():
            if isinstance(v, dict):
                so = v.get("sort_order", 0)
                if isinstance(so, int) and so > max_order:
                    max_order = so
        return max_order + 1

    def create(self, template: PromptTemplate) -> PromptTemplate:
        with _LOCK:
            if not template.sort_order:
                template.sort_order = self._next_sort_order()
            self._data[template.id] = template.to_dict()
            self._save()
        return template

    def update(self, template_id: str, template: PromptTemplate) -> Optional[PromptTemplate]:
        with _LOCK:
            if template_id not in self._data:
                return None
            template.id = template_id
            from datetime import datetime, timezone
            template.updated_at = datetime.now(timezone.utc).isoformat()
            self._data[template_id] = template.to_dict()
            self._save()
        return template

    def delete(self, template_id: str) -> bool:
        with _LOCK:
            if template_id not in self._data:
                return False
            # 内置模板删除后记录到 _deleted_builtins，避免重启后 _ensure_builtins 重建
            if template_id.startswith("builtin-"):
                deleted = self._data.get("_deleted_builtins", [])
                if not isinstance(deleted, list):
                    deleted = []
                if template_id not in deleted:
                    deleted.append(template_id)
                    self._data["_deleted_builtins"] = deleted
            del self._data[template_id]
            self._save()
        return True

    def reorder(self, template_ids: List[str]) -> bool:
        """按传入的 id 顺序重新分配 sort_order（数字越小越靠前）。"""
        with _LOCK:
            order_map = {tid: i for i, tid in enumerate(template_ids)}
            for tid, v in self._data.items():
                if isinstance(v, dict) and tid in order_map:
                    v["sort_order"] = order_map[tid]
            self._save()
        return True

    # --- Session pending results ---
    # v1.3.0: pending 数据是纯运行时状态，改用内存 dict，不再混入 _data 落盘

    def get_pending(self, session_id: str) -> Optional[dict]:
        with _LOCK:
            return self._pending.get(session_id)

    def set_pending(self, session_id: str, result: dict) -> None:
        with _LOCK:
            self._pending[session_id] = result

    def clear_pending(self, session_id: str) -> None:
        with _LOCK:
            self._pending.pop(session_id, None)


class SettingsStore:
    """Persist plugin settings to a JSON file (separate from templates)."""

    _DEFAULTS = {
        "model_id": "",
        "include_context": False,
        "context_rounds": 5,
        # v1.3.4: 上下文截取设置（默认均衡模式：头+尾）
        "ctx_trunc_head": True,
        "ctx_trunc_middle": False,
        "ctx_trunc_tail": True,
        "ctx_trunc_head_b": 500,
        "ctx_trunc_middle_b": 1000,
        "ctx_trunc_tail_b": 500,
        "ctx_trunc_unit": "char",
        "ctx_trunc_marker": True,
        # v1.4.0: 项目感知
        "include_project": True,
        # v1.4.1: 面板设置优先开关（true=面板覆盖模板设置；false=以各模板内设置为准）
        "settings_priority": True,
    }

    def __init__(self, path: str | Path | None = None):
        if path is None:
            path = Path(__file__).resolve().parent.parent / "settings.json"
        self._path = Path(path)
        self._data: dict = dict(self._DEFAULTS)
        self._load()

    def _load(self) -> None:
        try:
            if self._path.exists():
                with open(self._path, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                if isinstance(saved, dict):
                    self._data.update(saved)
        except Exception:
            pass

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(self._path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self._data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, str(self._path))
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def get(self) -> dict:
        return dict(self._data)

    def update(self, settings: dict) -> dict:
        with _LOCK:
            # 只更新已知字段，忽略未知字段
            for key in self._DEFAULTS:
                if key in settings:
                    self._data[key] = settings[key]
            self._save()
        return dict(self._data)

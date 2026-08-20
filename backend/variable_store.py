"""Variable store — persists user-defined custom variables.

Variables are stored separately from templates so one variable can be
referenced by multiple templates. Rendered as {{name}} in templates.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List

_LOCK = threading.Lock()

# 内置保留变量名 — 不允许自定义变量使用
BUILTIN_RESERVED_NAMES = frozenset({
    "originalPrompt", "userQuestion", "currentPrompt", "iterateInput",
    "lastOptimizedPrompt", "conversationContext", "toolsContext",
    "projectContext",
})


class VariableStore:
    """Persist user-defined variables to a JSON file."""

    def __init__(self, path: str | Path | None = None):
        if path is None:
            path = Path(__file__).resolve().parent.parent / "variables.json"
        self._path = Path(path)
        self._data: dict = {"variables": []}
        self._load()

    def _load(self) -> None:
        try:
            if self._path.exists():
                with open(self._path, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                    if isinstance(loaded, dict) and isinstance(loaded.get("variables"), list):
                        self._data = loaded
        except Exception:
            self._data = {"variables": []}

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

    def list_variables(self) -> List[dict]:
        """Return all variables as list of dicts."""
        with _LOCK:
            return [dict(v) for v in self._data.get("variables", [])]

    def get_all_as_map(self) -> dict:
        """Return {name: value} map for template rendering."""
        with _LOCK:
            return {v["name"]: v.get("value", "")
                    for v in self._data.get("variables", [])
                    if v.get("name")}

    def create(self, name: str, value: str = "", description: str = "", label: str = "") -> dict:
        """Create a new variable. Raises ValueError if name invalid/duplicate."""
        name = name.strip()
        if not name:
            raise ValueError("变量名不能为空")
        if name in BUILTIN_RESERVED_NAMES:
            raise ValueError(f"变量名 '{name}' 是系统保留变量，请换一个")
        with _LOCK:
            for v in self._data.get("variables", []):
                if v.get("name") == name:
                    raise ValueError(f"变量名 '{name}' 已存在")
            now = datetime.now(timezone.utc).isoformat()
            var = {
                "id": uuid.uuid4().hex[:12],
                "name": name,
                "label": label.strip(),
                "value": value,
                "description": description,
                "created_at": now,
                "updated_at": now,
            }
            self._data.setdefault("variables", []).append(var)
            self._save()
            return dict(var)

    def update(self, var_id: str, name: str, value: str = "",
               description: str = "", label: str = "") -> dict | None:
        """Update a variable by id. Raises ValueError on name conflict."""
        name = name.strip()
        if not name:
            raise ValueError("变量名不能为空")
        if name in BUILTIN_RESERVED_NAMES:
            raise ValueError(f"变量名 '{name}' 是系统保留变量，请换一个")
        with _LOCK:
            for v in self._data.get("variables", []):
                if v.get("id") == var_id:
                    for other in self._data.get("variables", []):
                        if other.get("id") != var_id and other.get("name") == name:
                            raise ValueError(f"变量名 '{name}' 已被其他变量使用")
                    v["name"] = name
                    v["label"] = label.strip()
                    v["value"] = value
                    v["description"] = description
                    v["updated_at"] = datetime.now(timezone.utc).isoformat()
                    self._save()
                    return dict(v)
            return None

    def delete(self, var_id: str) -> bool:
        """Delete a variable by id."""
        with _LOCK:
            variables = self._data.get("variables", [])
            for i, v in enumerate(variables):
                if v.get("id") == var_id:
                    variables.pop(i)
                    self._save()
                    return True
            return False

"""ProjectStore — 项目感知缓存（磁盘 project_cache.json + 进程内）。

key = 项目绝对路径。命中条件：compute_signature 与上次一致才复用，否则重扫。
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .project_scanner import compute_signature, scan_project

logger = logging.getLogger(__name__)

_LOCK = threading.Lock()


class ProjectStore:
    """Persist scanned project info to a JSON file (project_cache.json)."""

    def __init__(self, path: str | Path | None = None):
        if path is None:
            path = Path(__file__).resolve().parent.parent / "project_cache.json"
        self._path = Path(path)
        self._data: dict = {}
        self._load()

    def _load(self) -> None:
        try:
            if self._path.exists():
                with open(self._path, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    self._data = loaded
        except Exception:
            self._data = {}

    def _save(self) -> None:
        try:
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
        except Exception as exc:  # 缓存失败不影响主流程
            logger.warning("project cache save failed: %s", exc)

    def get_cached(self, project_path: str) -> Optional[dict]:
        with _LOCK:
            item = self._data.get(str(project_path))
            return item if isinstance(item, dict) else None

    def save(self, project_path: str, info: dict, signature: str) -> None:
        with _LOCK:
            self._data[str(project_path)] = {
                "info": info,
                "signature": signature,
                "cached_at": datetime.now(timezone.utc).isoformat(),
            }
            self._save()

    def get_project_info(self, project_dir: Path, depth: int = 2, force: bool = False) -> dict:
        """按签名缓存策略取项目信息；force=True 强制重扫。"""
        project_dir = Path(project_dir)
        key = str(project_dir)
        if not force:
            try:
                sig = compute_signature(project_dir, depth)
            except Exception:
                sig = ""
            cached = self.get_cached(key)
            if cached:
                old_sig = cached.get("signature")
                if old_sig and sig and old_sig == sig:
                    info = cached.get("info")
                    return info if isinstance(info, dict) else self._scan_and_save(project_dir, depth)
        return self._scan_and_save(project_dir, depth)

    def _scan_and_save(self, project_dir: Path, depth: int) -> dict:
        try:
            info = scan_project(project_dir, depth)
        except Exception as exc:
            logger.warning("project scan failed %s: %s", project_dir, exc)
            info = {
                "path": str(project_dir),
                "name": project_dir.name,
                "language": None,
                "frameworks": [],
                "build_tool": None,
                "error": str(exc),
                "scanned_at": datetime.now(timezone.utc).isoformat(),
            }
        try:
            sig = compute_signature(project_dir, depth)
        except Exception:
            sig = ""
        self.save(str(project_dir), info, sig)
        return info
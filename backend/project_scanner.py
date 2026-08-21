"""Project scanner for prompt-optimizer-plus — 项目感知。

识别当前项目：
- 语言/构建工具（按关键文件存在性）
- 框架（解析 package.json / pom.xml 关键依赖）
- 目录结构（顶层目录/多模块）
- 生成缓存签名（关键配置文件 mtime+size + 顶层目录名 → sha256）

安全限制：只读白名单文本、单文件 ≤64KB、忽略噪音目录、扫描条目上限、不跟随 symlink。
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# 忽略的目录（不参与结构扫描）
_IGNORE_DIRS = frozenset({
    "node_modules", ".git", ".svn", ".hg", "dist", "build", "target", "venv",
    ".venv", "__pycache__", ".idea", ".vscode", ".next", ".nuxt", "out",
    "coverage", ".mypy_cache", ".pytest_cache", ".ruff_cache", "htmlcov",
})

# 语言/构建工具识别（优先级顺序）
_LANG_MARKERS: list[tuple[tuple[str, ...], str, str]] = [
    (("pom.xml",), "Java", "Maven"),
    (("build.gradle", "build.gradle.kts", "settings.gradle"), "Java", "Gradle"),
    (("csproj",), "C#", ".NET"),  # 任意 .csproj
    (("go.mod",), "Go", "Go Modules"),
    (("Cargo.toml",), "Rust", "Cargo"),
    (("pyproject.toml", "requirements.txt", "setup.py", "Pipfile"), "Python", "pip"),
    (("package.json",), "JavaScript", "npm"),
    (("composer.json",), "PHP", "Composer"),
    (("Gemfile",), "Ruby", "Bundler"),
    (("*.csproj",), "C#", ".NET"),
]

# 框架识别：package.json dependencies 关键字 → 框架名
_JS_FRAMEWORK_RULES: list[tuple[tuple[str, ...], str]] = [
    (("next",), "Next.js"),
    (("nuxt",), "Nuxt"),
    (("vue",), "Vue"),
    (("react",), "React"),
    (("svelte",), "Svelte"),
    (("@angular/core",), "Angular"),
    (("@nestjs/core",), "NestJS"),
    (("express",), "Express"),
    (("fastify",), "Fastify"),
    (("vite",), "Vite"),
    (("webpack",), "Webpack"),
    (("pinia",), "Pinia"),
    (("redux",), "Redux"),
    (("element-plus",), "Element Plus"),
    (("ant-design-vue",), "Ant Design Vue"),
    (("antd",), "Ant Design"),
    (("tailwindcss",), "Tailwind CSS"),
]

# framework 检测：pom.xml 关键词
_POM_FRAMEWORK_RULES: list[tuple[tuple[str, ...], str]] = [
    (("spring-boot",), "Spring Boot"),
    (("spring-cloud",), "Spring Cloud"),
    (("mybatis-plus", "mybatis-plus-boot-starter"), "MyBatis-Plus"),
    (("mybatis",), "MyBatis"),
    (("sa-token", "satoken"), "Sa-Token"),
    (("xxl-job",), "XXL-Job"),
    (("dubbo",), "Dubbo"),
    (("shardingsphere",), "ShardingSphere"),
    (("redis",), "Redis"),
    (("rocketmq",), "RocketMQ"),
    (("kafka",), "Kafka"),
    (("elasticsearch", "spring-boot-starter-data-elasticsearch"), "Elasticsearch"),
]

# 签名参与文件：白名单（顶层直接命中；含 * 的按 glob）
_SIGNATURE_FILES = (
    "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
    "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
    "pyproject.toml", "requirements.txt", "setup.py", "Pipfile",
    "go.mod", "go.sum", "Cargo.toml", "Cargo.lock",
    "composer.json", "Gemfile", "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
    "README.md", "vite.config.ts", "vite.config.js", "tsconfig.json",
    "application.yml", "application.yaml", "application.properties",
    "*.csproj",
)

# 可解析的配置/清单文件 → 提取关键值
_PARSEABLE = {
    "package.json": ("json",),
    "pom.xml": ("xml",),
    "application.yml": ("yaml",),
    "application.yaml": ("yaml",),
    "application.properties": ("props",),
    "pyproject.toml": ("toml",),
}

_MAX_FILE_BYTES = 64 * 1024  # 单文件读取上限 64KB
_MAX_SCAN_ITEMS = 100        # 结构扫描条目上限
_SCAN_TIMEOUT_MS = 2000      # 整个扫描超时 2s

# Scanner 逻辑版本号：纳入签名 payload，scanner 逻辑升级后旧缓存自动失效
_SCANNER_VERSION = 3  # v1.4.2: sub_projects 带语言/构建工具


def _is_ignored(name: str) -> bool:
    return name in _IGNORE_DIRS or name.startswith(".")


def _sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8", errors="replace")).hexdigest()


# --- 签名 ---

def _match_sig_patterns(project_dir: Path) -> list[tuple[str, int, int]]:
    """收集签名文件 (name, mtime_ns, size)。包含 * 的 pattern 用 glob 匹配顶层。"""
    project_dir = Path(project_dir)
    parts: list[tuple[str, int, int]] = []
    globbed: set[str] = set()
    try:
        for entry in os.scandir(project_dir):
            if not entry.is_file():
                continue
            name = entry.name
            # 静态名单命中
            if name in _SIGNATURE_FILES or ("*" in name):
                stat = entry.stat(follow_symlinks=False)
                parts.append((name, stat.st_mtime_ns, stat.st_size))
                globbed.add(name)
    except OSError:
        pass
    # 通配 pattern（如 *.csproj）单独匹配
    for pat in _SIGNATURE_FILES:
        if "*" not in pat:
            continue
        try:
            for p in project_dir.glob(pat):
                if p.is_file() and p.name not in globbed:
                    st = p.stat()
                    parts.append((p.name, st.st_mtime_ns, st.st_size))
        except OSError:
            continue
    return sorted(parts)


def compute_signature(project_dir: Path, depth: int) -> str:
    """缓存签名：关键配置文件 (name, mtime_ns, size) + 顶层目录名列表。"""
    project_dir = Path(project_dir)
    parts = _match_sig_patterns(project_dir)
    top = []
    try:
        for entry in os.scandir(project_dir):
            if entry.is_dir() and not _is_ignored(entry.name):
                top.append(entry.name)
    except OSError:
        pass
    top.sort()
    payload = json.dumps({"files": parts, "top": top, "depth": depth, "sv": _SCANNER_VERSION}, ensure_ascii=False, sort_keys=True)
    return _sha256_hex(payload)


# --- 文件解析（安全） ---

def _read_text(path: Path) -> Optional[str]:
    try:
        if not path.is_file():
            return None
        if path.stat().st_size > _MAX_FILE_BYTES:
            return None
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(_MAX_FILE_BYTES + 1)
    except OSError:
        return None


def _parse_json(text: str) -> dict:
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _extract_pom(pom_text: str) -> dict:
    out: dict[str, Any] = {}
    m = re.search(r"<artifactId>\s*([^<]+?)\s*</artifactId>", pom_text)
    if m:
        # 项目名用顶层 artifactId（跳过 spring-boot-starter-parent 等父 POM 引用）
        top = re.search(r"<project>[\s\S]*?<artifactId>\s*([^<]+?)\s*</artifactId>", pom_text)
        if top and top.group(1).strip() not in ("spring-boot-starter-parent",):
            out["name"] = top.group(1).strip()
        else:
            out["name"] = m.group(1).strip()
    m = re.search(r"<java\.version>\s*([^<]+?)\s*</java\.version>", pom_text)
    if m:
        out["java_version"] = m.group(1).strip()
    m = re.search(r"<maven\.compiler\.source>\s*([^<]+?)\s*</maven\.compiler\.source>", pom_text)
    if m and "java_version" not in out:
        out["java_version"] = m.group(1).strip()
    m = re.search(r"<version>\s*([^<]+?)\s*</version>", pom_text)  # 首个 version（父 POM）
    m2 = re.search(r"<artifactId>spring-boot-starter-parent</artifactId>\s*<version>\s*([^<]+?)\s*</version>", pom_text)
    if m2:
        out["spring_boot_version"] = m2.group(1).strip()
    elif m:
        pass  # 不取首个 version（容易误判）
    m = re.search(r"<groupId>\s*([^<]+?)\s*</groupId>", pom_text)
    if m:
        out["package"] = m.group(1).strip()
    modules = re.findall(r"<module>\s*([^<]+?)\s*</module>", pom_text)
    if modules:
        out["modules"] = [x.strip() for x in modules]
    return out


def _detect_js_frameworks(deps: dict) -> list[str]:
    found: list[str] = []
    keys = {k.lower() for k in deps.keys()}
    for needles, label in _JS_FRAMEWORK_RULES:
        if any(n in keys or any(n == k.split("/")[-1] for k in keys) for n in needles):
            found.append(label)
    return found


def _detect_pom_frameworks(pom_text: str) -> list[str]:
    text = pom_text.lower()
    found: list[str] = []
    for needles, label in _POM_FRAMEWORK_RULES:
        if any(n in text for n in needles):
            found.append(label)
    return found


# --- 扫描 ---

def _scan_structure(project_dir: Path, depth: int) -> dict:
    """顶层目录/文件 + 子模块，限制条数与深度。"""
    top_dirs: list[str] = []
    top_files: list[str] = []
    try:
        for entry in os.scandir(project_dir):
            if _is_ignored(entry.name):
                continue
            if entry.is_dir(follow_symlinks=False):
                top_dirs.append(entry.name + "/")
            elif entry.is_file(follow_symlinks=False):
                top_files.append(entry.name)
            if len(top_dirs) + len(top_files) >= _MAX_SCAN_ITEMS:
                break
    except OSError:
        pass
    top_dirs.sort()
    top_files.sort()
    out: dict[str, Any] = {"dirs": top_dirs[:60], "files": top_files[:40]}
    # depth=2：补子模块关键目录（若存在 pom 模块 / workspaces）
    if depth >= 2:
        subs: list[str] = []
        for d in top_dirs:
            d = d.rstrip("/")
            try:
                sub = project_dir / d
                if not sub.is_dir():
                    continue
                for entry in os.scandir(sub):
                    if entry.is_dir() and not _is_ignored(entry.name) and len(subs) < 20:
                        subs.append(d + "/" + entry.name + "/")
            except OSError:
                continue
        subs.sort()
        out["subdirs"] = subs[:20]
    return out


def scan_project(project_dir: Path, depth: int = 2) -> dict:
    """扫描项目，返回 ProjectInfo dict（不会抛异常，尽力而为）。"""
    start = time.monotonic()
    project_dir = Path(project_dir)
    info: dict[str, Any] = {
        "path": str(project_dir),
        "name": project_dir.name,
        "language": None,
        "frameworks": [],
        "build_tool": None,
        "package_managers": [],
        "key_files": {},
        "configs": {},
        "top_level": [],
        "modules": [],
        "scanned_at": datetime.now(timezone.utc).isoformat(),
    }

    try:
        entries = list(os.scandir(project_dir))
    except OSError:
        return _finalize(info, start)

    names = {e.name: e for e in entries}
    files = {n: e for n, e in names.items() if e.is_file()}
    dirs = {n: e for n, e in names.items() if e.is_dir()}

    # 1. 语言/构建工具
    def _match_markers(filenames: set[str]) -> Optional[tuple[str, str]]:
        for markers, lang, tool in _LANG_MARKERS:
            for mk in markers:
                if mk.startswith("*") and mk.endswith(".csproj"):
                    if any(n.endswith(".csproj") for n in filenames):
                        return lang, tool
                elif mk in filenames:
                    return lang, tool
        return None

    root_hit = _match_markers(set(files))
    matched_subdirs: list[dict] = []  # [{"dir": d, "language": l, "build_tool": t}] 聚合目录命中的子项目
    if root_hit:
        info["language"], info["build_tool"] = root_hit
    else:
        # 聚合工作区：根目录没有语言标记时，扫一层子目录找（多项目并存）
        # 收集所有命中（如 Java 后端 + Vue 前端并存），不只取第一个
        for dname in sorted(dirs)[:20]:
            if _is_ignored(dname):
                continue
            try:
                sub_names = {e.name for e in os.scandir(project_dir / dname)}
            except OSError:
                continue
            sub_hit = _match_markers(sub_names)
            if sub_hit:
                if not info["language"]:
                    # 第一个命中作为主语言
                    info["language"], info["build_tool"] = sub_hit
                    info["configs"]["project_dir_hint"] = dname
                matched_subdirs.append({"dir": dname, "language": sub_hit[0], "build_tool": sub_hit[1]})
        # 多语言场景记录子项目列表（含各自语言/构建工具）
        if matched_subdirs:
            info["configs"]["sub_projects"] = matched_subdirs

    # 2. 包管理器（锁文件优先）— 根目录 + 所有命中子目录
    _scan_dirs_for_files = [files]  # 根目录文件集
    for sp in matched_subdirs:
        try:
            _scan_dirs_for_files.append({e.name for e in os.scandir(project_dir / sp["dir"])})
        except OSError:
            continue
    _all_files_flat = set()
    for fs in _scan_dirs_for_files:
        _all_files_flat.update(fs)
    if "package-lock.json" in _all_files_flat or "package.json" in _all_files_flat:
        info["package_managers"].append("npm")
    if "pnpm-lock.yaml" in _all_files_flat:
        info["package_managers"].append("pnpm")
    if "yarn.lock" in _all_files_flat:
        info["package_managers"].append("yarn")
    if "pom.xml" in _all_files_flat:
        info["package_managers"].append("Maven Central")
    if "pyproject.toml" in _all_files_flat or "requirements.txt" in _all_files_flat:
        info["package_managers"].append("PyPI")
    if "go.mod" in _all_files_flat:
        info["package_managers"].append("Go Proxy")

    # 3. 关键文件标记（根目录）
    for f in sorted(files):
        if f in {"README.md", "LICENSE", ".gitignore"}:
            info["key_files"][f] = "exists"
    for name in ("pom.xml", "build.gradle", "package.json", "pyproject.toml", "requirements.txt",
                 "go.mod", "Cargo.toml", "docker-compose.yml", "application.yml", "application.yaml",
                 "Dockerfile", "vite.config.ts", "tsconfig.json", "pnpm-lock.yaml", "yarn.lock"):
        if name in files:
            info["key_files"][name] = "exists"
    # 聚合目录子项目关键文件也标记（带子目录前缀）
    for sp in matched_subdirs:
        dname = sp["dir"]
        try:
            sub_files = {e.name for e in os.scandir(project_dir / dname)}
        except OSError:
            continue
        for name in ("pom.xml", "package.json", "pyproject.toml", "requirements.txt",
                     "go.mod", "Cargo.toml", "docker-compose.yml", "vite.config.ts"):
            if name in sub_files:
                info["key_files"][dname + "/" + name] = "exists"

    # 4. 解析关键配置 — 根目录 + 所有命中子目录（合并框架列表）
    _parse_dirs = [project_dir] + [project_dir / sp["dir"] for sp in matched_subdirs]
    for _parse_dir in _parse_dirs:
        try:
            _dir_files = {e.name for e in os.scandir(_parse_dir)}
        except OSError:
            continue
        # package.json → JS 框架
        if "package.json" in _dir_files:
            pkg = _parse_json(_read_text(_parse_dir / "package.json") or "{}")
            if pkg.get("name") and "name" not in info.get("configs", {}):
                info["configs"]["name"] = str(pkg["name"])[:60]
            deps = {}
            if isinstance(pkg.get("dependencies"), dict):
                deps.update(pkg["dependencies"])
            if isinstance(pkg.get("devDependencies"), dict):
                deps.update(pkg["devDependencies"])
            fw = _detect_js_frameworks(deps)
            if fw:
                info["frameworks"].extend(fw)
            if "packageManager" in pkg:
                info["configs"]["package_manager"] = str(pkg["packageManager"])[:40]
        # pom.xml → Java 框架
        if "pom.xml" in _dir_files:
            pom_text = _read_text(_parse_dir / "pom.xml") or ""
            if pom_text:
                # 聚合目录：用 artifactId 作为项目名
                if matched_subdirs:
                    m = re.search(r"<artifactId>\s*([^<]+?)\s*</artifactId>", pom_text)
                    if m and "name" not in info.get("configs", {}):
                        info["configs"]["name"] = m.group(1).strip()
                info["configs"].update(_extract_pom(pom_text))
                fw = _detect_pom_frameworks(pom_text)
                if fw:
                    info["frameworks"].extend(fw)
                modules = info["configs"].get("modules")
                if isinstance(modules, list):
                    info["modules"] = modules

    # 5. 目录结构
    structure = _scan_structure(project_dir, depth)
    info["top_level"] = structure["dirs"]
    info["key_files"]["..."] = None  # 占位清理
    info["key_files"].pop("...", None)
    if structure.get("files"):
        info["top_level"].extend(f for f in structure["files"][:10])
    if structure.get("subdirs") and not info["modules"]:
        info["sub_modules"] = structure["subdirs"]

    # 去重框架
    seen = set()
    info["frameworks"] = [f for f in info["frameworks"] if not (f in seen or seen.add(f))]

    # 项目名优先用配置提取（artifactId / package.json name），fallback 目录名
    cfg_name = info.get("configs", {}).get("name")
    if isinstance(cfg_name, str) and cfg_name.strip():
        info["name"] = cfg_name.strip()[:60]

    return _finalize(info, start)


def _finalize(info: dict, start: float) -> dict:
    elapsed_ms = (time.monotonic() - start) * 1000
    info["scan_ms"] = round(elapsed_ms, 1)
    return info


def run_scan_and_sign(project_dir: Path, depth: int) -> tuple[dict, str]:
    """扫描 + 算签名，供缓存使用。"""
    info = scan_project(project_dir, depth)
    sig = compute_signature(project_dir, depth)
    return info, sig
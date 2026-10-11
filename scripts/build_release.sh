#!/usr/bin/env bash
# 构建插件安装包 zip —— 本地与 GitHub Actions 共用，保证产物一致。
# 用法: bash scripts/build_release.sh
# 产物: dist/<id>-v<version>.zip
# 结构: 平铺（plugin.json 在 zip 根部，与已验证的安装链路一致）
# 打包口径: 仅发布文件清单，排除 __pycache__、*_TODO.md、TEST_PLAN、dist 等
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json;print(json.load(open('plugin.json'))['version'])")
NAME=$(python3 -c "import json;print(json.load(open('plugin.json'))['id'])")
OUT_DIR="dist"
ZIP_NAME="${NAME}-v${VERSION}.zip"

# GitHub Actions 的 checkout 不带 .git，此时用 find 兜底
if git rev-parse --git-dir >/dev/null 2>&1; then
  FILE_LIST=$(git ls-files | grep -Ev '^(TEST_PLAN\.md|scripts/|\.github/|\.gitignore$)')
else
  FILE_LIST=$(find . -type f \
    ! -path './.git/*' ! -path './__pycache__/*' ! -path '*/__pycache__/*' \
    ! -path './scripts/*' ! -path './.github/*' ! -path './dist/*' \
    ! -name '*_TODO.md' ! -name 'TEST_PLAN.md' ! -name '*.zip' \
    ! -name '.gitignore' ! -name '.DS_Store' | sed 's|^\./||')
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

(cd . && zip -qr "$OUT_DIR/$ZIP_NAME" $FILE_LIST)

# 校验: plugin.json 必须在 zip 根部
unzip -l "$OUT_DIR/$ZIP_NAME" | grep -E " plugin\.json$" >/dev/null
echo "✅ 构建完成: $OUT_DIR/$ZIP_NAME"
echo "   版本: v${VERSION} | 文件数: $(unzip -l "$OUT_DIR/$ZIP_NAME" | tail -1 | awk '{print $2}')"

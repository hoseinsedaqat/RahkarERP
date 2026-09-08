#!/usr/bin/env bash
#
# انتشار یک‌دستوری شاخه روی GitHub و ساخت Pull Request
#
#   bash scripts/publish.sh
#
# متغیرهای قابل تنظیم (اختیاری):
#   BRANCH=arena/01a05d72-arenaai   شاخه مبدأ
#   BASE=main                       شاخه مقصد
#
# نکته: اگر تاریخچه‌ی محلی با remote تفاوت کرده باشد، اسکریپت با reset --soft
# تغییرات را روی آخرین وضعیت remote بازسازی می‌کند تا push بدون force انجام شود؛
# محتوای فایل‌ها در هیچ حالتی از بین نمی‌رود.
#
set -uo pipefail

BRANCH="${BRANCH:-arena/01a05d72-arenaai}"
BASE="${BASE:-main}"
TITLE="نسخه وب: داشبورد پویا، لندینگ جدید و انتشار روی GitHub Pages"

cd "$(dirname "$0")/.." || exit 1

echo "→ همگام‌سازی با remote..."
git fetch origin "$BRANCH" 2>/dev/null || echo "  (شاخه روی remote یافت نشد؛ ادامه به‌صورت معمولی)"

if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  echo "→ بازسازی تغییرات روی آخرین وضعیت remote..."
  git reset --soft "origin/$BRANCH"
  git commit -m "$TITLE" 2>/dev/null || echo "  (تغییر جدیدی برای کامیت وجود ندارد)"
else
  git add -A
  git commit -m "$TITLE" 2>/dev/null || echo "  (تغییر جدیدی برای کامیت وجود ندارد)"
fi

echo "→ انتشار شاخه $BRANCH..."
if ! git push origin "$BRANCH"; then
  echo "⚠️  push ناموفق بود. اگر اختلاف تاریخچه دارید، یک‌بار با force-with-lease امتحان کنید:"
  echo "    git push --force-with-lease origin $BRANCH"
  exit 1
fi

if command -v gh >/dev/null 2>&1; then
  echo "→ ساخت Pull Request..."
  if gh pr create --base "$BASE" --head "$BRANCH" --title "$TITLE" --body-file PR.md; then
    echo "✅ Pull Request ساخته شد."
  else
    echo "⚠️  ساخت PR ناموفق بود یا از قبل وجود دارد. آدرس را اینجا ببینید:"
    echo "    https://github.com/h03einsedaqat/arenaai/compare/$BASE...$BRANCH"
  fi
else
  echo "برای ساخت PR این آدرس را باز کنید:"
  echo "    https://github.com/h03einsedaqat/arenaai/compare/$BASE...$BRANCH?expand=1"
  echo "و متن فایل PR.md را در توضیحات قرار دهید."
fi

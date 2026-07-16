#!/bin/bash
# SessionStart hook — CLAUDE.md 건강 점검.
# ① 80줄 초과로 비대해진 CLAUDE.md를 찾고
# ② 마지막 정리(.claude/.md-cleanup-stamp) 후 7일이 지났으면
# 정리 알림을 대화 맥락에 주입한다. 실제 정리는 Claude가
# 루트 CLAUDE.md의 "CLAUDE.md 관리" 규칙에 따라 수행.

set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAMP="$ROOT/.claude/.md-cleanup-stamp"
MAX_LINES=80
INTERVAL_DAYS=7

# 비대 파일 수집 (node_modules/dist 제외)
oversized=""
while IFS= read -r f; do
  lines=$(wc -l < "$f" | tr -d ' ')
  if [ "$lines" -gt "$MAX_LINES" ]; then
    oversized="${oversized}  - ${f#$ROOT/} (${lines}줄)\n"
  fi
done < <(find "$ROOT" -name CLAUDE.md -not -path '*/node_modules/*' -not -path '*/dist/*' -not -path '*/.git/*')

# 주기 확인
now=$(date +%s)
last=0
[ -f "$STAMP" ] && last=$(cat "$STAMP" 2>/dev/null || echo 0)
case "$last" in (*[!0-9]*|"") last=0;; esac
elapsed_days=$(( (now - last) / 86400 ))

if [ -n "$oversized" ] && [ "$elapsed_days" -ge "$INTERVAL_DAYS" ]; then
  printf '[md-health-check] CLAUDE.md 정리 알림: 마지막 정리 후 %s일 경과, %s줄 초과 파일이 있습니다.\n' "$elapsed_days" "$MAX_LINES"
  printf '%b' "$oversized"
  printf '본작업을 먼저 끝낸 뒤, 위 파일만 /claude-md-improver 로 압축·정리하고 `date +%%s > .claude/.md-cleanup-stamp` 로 타임스탬프를 갱신할 것.\n'
fi
exit 0

#!/bin/bash
# Stop hook — 의미 있는 코드 변경이 있었으면 Claude에게 자동 후처리(코덱스 리뷰 + CLAUDE.md
# 갱신)를 지시한다. 커밋 여부와 무관하게 "코드 내용의 지문"이 달라졌는지로 판단하므로
# 커밋 없이 세션을 끝내도 다음 멈춤 시점에 걸린다. 문서(md)만 바뀐 경우는 발동하지 않는다.
#
# 상태 파일(.claude/.post-work-*)은 기기별 상태라 gitignore 대상.

cd "$CLAUDE_PROJECT_DIR" || exit 0

STATE=".claude/.post-work-state"        # 마지막으로 후처리를 마친 코드 지문
FLAG=".claude/.post-work-inprogress"    # 직전 멈춤에서 후처리를 지시했음 — 이번엔 마무리만

# 코드 지문: 추적 중인 "로직" 경로의 (커밋/스테이지 내용 + 작업 트리 diff) 해시.
# 문서(md)와 스타일(css)만 바뀌면 지문이 안 변한다 — 단순 UI 수정에는 리뷰를 안 돌린다.
CODE_PATHS=(src manifest.config.ts supabase/functions package.json)
fingerprint() {
  {
    git ls-files -s -- "${CODE_PATHS[@]}" 2>/dev/null | grep -v -E '\.css$'
    git diff -- "${CODE_PATHS[@]}" ':(exclude)*.css' 2>/dev/null
  } | shasum | cut -d' ' -f1
}
CUR="$(fingerprint)"

# 직전 멈춤에서 후처리를 시켰다면: 이번 멈춤은 그 후처리가 끝난 시점 — 지문을 갱신하고 종료.
# (후처리 중 코드가 또 바뀌어도 여기서 지문에 흡수돼 무한 반복을 막는다)
if [ -f "$FLAG" ]; then
  rm -f "$FLAG"
  echo "$CUR" > "$STATE"
  exit 0
fi

# 첫 실행이면 기준선만 기록 (과거 작업에 소급 발동 방지).
if [ ! -f "$STATE" ]; then
  echo "$CUR" > "$STATE"
  exit 0
fi

LAST="$(cat "$STATE")"
[ "$CUR" = "$LAST" ] && exit 0

# 코드 변경 감지 → 1회성 후처리 지시.
touch "$FLAG"
cat <<'JSON'
{
  "decision": "block",
  "reason": "[자동 후처리] 이번 작업에서 소스 코드가 변경되었습니다. 다음을 순서대로 수행하세요. ① Skill 'codex'를 code review 모드로 호출해 마지막 후처리 이후의 코드 변경(git diff 및 최근 커밋)을 리뷰하고, 실제 결함만 사용자에게 한글로 보고한다(사소한 스타일 지적 제외). 발견된 결함의 수정 여부는 사용자에게 묻지 말고 명백한 버그만 고친다. ② 이번 작업에서 배운 재사용 가치가 있는 사실(gotcha·패턴·API 제약)이 있으면 해당 기능 폴더의 CLAUDE.md에 반영한다(루트 CLAUDE.md의 배치 규칙 준수). ③ 80줄을 초과한 CLAUDE.md가 있으면 /claude-md-improver로 정리한다. 할 것이 없으면 각 단계는 건너뛰고 한 줄로만 보고한다."
}
JSON
exit 0

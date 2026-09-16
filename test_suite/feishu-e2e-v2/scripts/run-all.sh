#!/usr/bin/env bash
# 飞书 E2E v2 一键流水线。
#
#   bash test_suite/feishu-e2e-v2/scripts/run-all.sh                # 正式跑：体检 → 3 轮重复运行 → 汇总报告
#   bash test_suite/feishu-e2e-v2/scripts/run-all.sh --draft        # 草稿：只看结构和 prompt 干不干净，不碰平台
#   bash test_suite/feishu-e2e-v2/scripts/run-all.sh --runs 1       # 只跑 1 轮（先验证链路通不通）
#   bash test_suite/feishu-e2e-v2/scripts/run-all.sh --auto-reset   # 每轮开跑前自动恢复消耗型前置（要 lark-cli user token 有效）
#   bash test_suite/feishu-e2e-v2/scripts/run-all.sh --skip-preflight
#   bash test_suite/feishu-e2e-v2/scripts/run-all.sh --report-only  # 不跑评测，只把已有的几个 run 汇总成报告
#   FORCE=1 bash ...                                                # 体检不过也硬跑（不推荐，结论会带 BLOCKED 噪音）
#
# 为什么 3 轮必须串行：飞书写操作共用同一批前置资源（同一场会、同一篇文档、同一间会议室），
# 并行会互相踩；所有 case 共用 bindings.v2.json 顶层真实 uid/sid，同一批 case 和重复轮次都只能串行跑。
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROOT="$(pwd)"
V2="test_suite/feishu-e2e-v2"
BINDINGS="$V2/bindings.v2.json"
LOGDIR="$V2/.local/logs"
mkdir -p "$LOGDIR"

RUNS=3
DRAFT=0
AUTO_RESET=0
SKIP_PREFLIGHT=0
REPORT_ONLY=0
SKIP_BLOCKED=""
TIMEOUT_MIN="${TIMEOUT_MIN:-240}"
EXTRA_RUN_IDS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --draft) DRAFT=1 ;;
    --auto-reset) AUTO_RESET=1 ;;
    --skip-preflight) SKIP_PREFLIGHT=1 ;;
    --report-only) REPORT_ONLY=1 ;;
    --skip-blocked) SKIP_BLOCKED="--skip-blocked" ;;
    --runs) shift; RUNS="$1" ;;
    --timeout-min) shift; TIMEOUT_MIN="$1" ;;
    --run) shift; EXTRA_RUN_IDS+=("$1") ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）"; exit 2 ;;
  esac
  shift
done

hr() { printf '\n════════ %s ════════\n' "$1"; }
die() { printf '\n✗ %s\n' "$1" >&2; exit 1; }

# --- 报告模式
if [[ "$REPORT_ONLY" == "1" ]]; then
  hr "汇总报告（--report-only）"
  ARGS=()
  for r in "${EXTRA_RUN_IDS[@]}"; do ARGS+=(--run "$r"); done
  [[ ${#ARGS[@]} -eq 0 ]] && die "没给 runId。用法：--report-only --run <id> [--run <id> ...]"
  npx tsx "$V2/scripts/report.ts" "${ARGS[@]}" --baseline "$(node -e "console.log(JSON.parse(require('fs').readFileSync('$V2/suite-config.json','utf8')).baseline_run_id||'')")"
  exit 0
fi

# --- 草稿模式
if [[ "$DRAFT" == "1" ]]; then
  hr "1/3 草稿构建（不绑前置、不碰平台）"
  npx tsx "$V2/build-cases.ts" --out "$V2/cases.v2.draft.jsonl" --allow-dirty
  hr "2/3 平台契约校验"
  npx tsx data_scripts/validate-cases.ts "$V2/cases.v2.draft.jsonl"
  hr "3/3 完成"
  echo "草稿产物：$ROOT/$V2/cases.v2.draft.jsonl"
  echo "草稿态只证明「结构合法、prompt 干净、断言条数在约束内」，不证明前置就绪。"
  echo "要真跑：cp $V2/bindings.v2.template.json ${BINDINGS}，填好 value/filled 和 7 个开关，再跑本脚本（不带 --draft）。"
  exit 0
fi

# --- 正式模式
[[ -f "$BINDINGS" ]] || die "缺 ${BINDINGS}。先执行：cp $V2/bindings.v2.template.json ${BINDINGS}，然后按 $V2/preflight-todo.md 填 32 条 value/filled + 7 个开关。"

if [[ "$SKIP_PREFLIGHT" == "1" ]]; then
  hr "0/4 跑前体检（已用 --skip-preflight 跳过）"
else
  hr "0/4 跑前体检"
  if ! npx tsx "$V2/scripts/preflight.ts" --probe; then
    echo
    echo "体检没过。上面「明天要做什么」/ $V2/preflight-todo.md 就是你要补的前置条件。"
    echo "补齐后重跑本脚本。真要硬跑：FORCE=1 bash $0 --skip-blocked（未就绪的 case 会记 BLOCKED，不进通过率分母）。"
    [[ "${FORCE:-0}" == "1" ]] || exit 1
    SKIP_BLOCKED="--skip-blocked"
  fi
fi

LABEL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$BINDINGS','utf8')).run_label||'')")
[[ -n "$LABEL" ]] || die "$BINDINGS 里 run_label 是空的。填一个本轮批次名（形如 0916A），它决定产物目录和报告批次，不参与 sid 生成。"

RUN_IDS=()
for ((N = 1; N <= RUNS; N++)); do
  hr "第 $N/$RUNS 轮 · 恢复消耗型前置"
  if [[ "$AUTO_RESET" == "1" ]]; then
    if [[ -f "$V2/scripts/reset-fixtures.ts" ]]; then
      npx tsx "$V2/scripts/reset-fixtures.ts" --bindings "$BINDINGS" --apply || die "第 $N 轮前置恢复失败。看上面的输出：哪一项、为什么。修好再重跑（可以 --runs 1 单独补这一轮）。"
    else
      echo "（reset-fixtures.ts 不存在，跳过自动恢复）"
    fi
  else
    cat <<TIP
本轮开跑前，确认这些消耗型前置是好的（上一轮跑完会被破坏）：
  · 待取消的会议：取消掉就没了 → 重建（明天上午、标题含「测试房间核验」+暗号、**已真实预订那间会议室**）
  · 待加人的会议：参会人恢复成只有本人
  · 待改期/换房的会议：时间、会议室、参会人恢复初始值
  · 被追加/改名的文档：恢复原样
  · 上一轮发出去的消息：撤不回，只在报告的人工清理清单里
想脚本化恢复：加 --auto-reset（需要 lark-cli user token 有效）。
TIP
    if [[ -t 0 && "${ASSUME_YES:-0}" != "1" ]]; then
      read -r -p "确认已恢复，回车开跑（Ctrl-C 退出）... " _
    else
      echo "（非交互环境 / ASSUME_YES=1，直接开跑）"
    fi
  fi

  hr "第 $N/$RUNS 轮 · 1/4 构建 cases"
  BUILD_LOG="$LOGDIR/build-r$N.log"
  npx tsx "$V2/build-cases.ts" --bindings "$BINDINGS" --run-index "$N" $SKIP_BLOCKED 2>&1 | tee "$BUILD_LOG"
  CASES=$(node -e "const s=require('fs').readFileSync('$BUILD_LOG','utf8');const i=s.indexOf('{');console.log(JSON.parse(s.slice(i)).output)")
  [[ -f "$CASES" ]] || die "构建产物不见了：$CASES"

  hr "第 $N/$RUNS 轮 · 2/4 平台契约校验"
  npx tsx data_scripts/validate-cases.ts "$CASES"

  hr "第 $N/$RUNS 轮 · 3/4 导入平台（整集替换，只动 v2 套件）"
  npx tsx "$V2/scripts/import-suite.ts" --cases "$CASES"

  hr "第 $N/$RUNS 轮 · 4/4 建 run 并等它跑完"
  RUN_LOG="$LOGDIR/run-r$N.log"
  set +e
  npx tsx "$V2/scripts/start-runs.ts" --run-index "$N" --label "$LABEL" --wait --timeout-min "$TIMEOUT_MIN" 2>&1 | tee "$RUN_LOG"
  RC=${PIPESTATUS[0]}
  set -e
  RID=$(grep -o 'RUN_ID=[0-9a-f-]\{36\}' "$RUN_LOG" | tail -1 | cut -d= -f2 || true)
  [[ -n "$RID" ]] || die "没拿到 runId（start-runs 退出码 ${RC}）。看 ${RUN_LOG}。"
  RUN_IDS+=("$RID")
  echo "第 $N 轮 runId：${RID}（start-runs 退出码 ${RC}）"
  if [[ "$RC" != "0" && "$N" -lt "$RUNS" ]]; then
    echo "这一轮没正常收尾。后面的轮次继续跑，但结论要打折；不想继续就 Ctrl-C，已完成的 runId 在上面。"
  fi
done

hr "汇总报告（${#RUN_IDS[@]} 轮取多数结论）"
RARGS=()
for r in "${RUN_IDS[@]}"; do RARGS+=(--run "$r"); done
BASELINE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$V2/suite-config.json','utf8')).baseline_run_id||'')")
[[ -n "$BASELINE" ]] && RARGS+=(--baseline "$BASELINE")
npx tsx "$V2/scripts/report.ts" "${RARGS[@]}"
echo
echo "runId 清单（贴给 report.ts 可以重出报告）："
for r in "${RUN_IDS[@]}"; do echo "  $r"; done

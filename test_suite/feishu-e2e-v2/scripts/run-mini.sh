#!/usr/bin/env bash
# 飞书 E2E v2 · MINI 冒烟子集（16 条）一键流水线。
#
#   bash test_suite/feishu-e2e-v2/scripts/run-mini.sh --dry-run    # 只构建 + 校验，不碰平台（草稿态，不需要 bindings）
#   bash test_suite/feishu-e2e-v2/scripts/run-mini.sh              # 构建 + 校验 + 导入平台（默认**不跑评测**）
#   bash test_suite/feishu-e2e-v2/scripts/run-mini.sh --run        # 再建 run 并等它跑完（必须有 bindings.v2.json）
#   bash test_suite/feishu-e2e-v2/scripts/run-mini.sh --run --runs 3          # 绑定态串行跑 3 轮（复用同一真实 uid/sid）
#   bash test_suite/feishu-e2e-v2/scripts/run-mini.sh --run --run-index 2     # 只补跑第 2 轮
#   bash test_suite/feishu-e2e-v2/scripts/run-mini.sh --report-only           # 只出报告（默认取上一批 --run 的 runId）
#   bash test_suite/feishu-e2e-v2/scripts/run-mini.sh --report-only --run-id <id> [--run-id <id> ...]
#
# 和 run-all.sh（全集 55 条）的区别，别搞混：
#   · 只构建 mini/case-ids.txt 里的 16 条（build-cases.ts --only），导到**独立套件**「飞书 E2E v2 MINI｜冒烟16条」，
#     和全集套件「飞书 E2E v2｜语音·视觉·安全」互不覆盖（平台导入是整集替换，但只替换同名的那一个套件）。
#   · 默认不跑评测：MINI 的用途是「验链路能不能跑通」，跑不跑由 --run 显式决定。
#   · 不跑 preflight：全集体检结论对 16 条子集没意义。前置够不够，看构建输出里的 blocked / warnings 就知道。
#   · 默认 1 轮（--runs 1），不是 3 轮：冒烟不需要「3 次取多数」，结论也不能当版本质量结论。
#
# ⚠ 未绑定（没有 bindings.v2.json）时构建出来的 prompt 里是 BIND_REQUIRED_xxx 占位、所有 case 都没有真实 uid/sid，
#   这种 case 导进平台只能看结构和断言长啥样，**真跑一定全红**。所以 --dry-run 之外的未绑定态可以导入，
#   但 --run 在未绑定态直接拒绝执行，不给你误跑的机会。
set -euo pipefail
# $0 是相对路径时，cd 之后就失效了；先把脚本自身的绝对路径存下来（--help 要用）
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/../../.."
ROOT="$(pwd)"
V2="test_suite/feishu-e2e-v2"
MINI="${V2}/mini"
ONLY_LIST="${MINI}/case-ids.txt"
BINDINGS="${V2}/bindings.v2.json"
LOGDIR="${V2}/.local/logs"
RUN_ID_FILE="${LOGDIR}/mini-run-ids.txt"
mkdir -p "${LOGDIR}"

SUITE_NAME="飞书 E2E v2 MINI｜冒烟16条"
FULL_SUITE_NAME="飞书 E2E v2｜语音·视觉·安全"

# 套件描述。默认用 mini/desc.mini.txt（平台上的描述和这里的文案是同一份，不会两处漂移）；
# 文件不在就用下面这段兜底。三个警告点（未绑定预览 / 不要现在运行 / 整集替换）两种来源都必须保留。
MINI_DESC='飞书 E2E v2 的冒烟子集：16 条，覆盖 7 个分域 / 37 个评测子项全量 / 5 种 A2UI 卡片，只缺 TEXT 卡。用于「先验证链路能不能跑通」，正式评测请用全集套件「飞书 E2E v2｜语音·视觉·安全」。⚠ 当前为未绑定预览：bindings.v2.json 未填，prompt 里含 BIND_REQUIRED_xxx 占位，不要现在点运行；填完 bindings 重跑本脚本会整集替换。'
DESC_SRC="脚本内置兜底文案"
if [[ -f "${MINI}/desc.mini.txt" ]]; then
  MINI_DESC="$(cat "${MINI}/desc.mini.txt")"
  DESC_SRC="${MINI}/desc.mini.txt"
fi
# 真正传给 import-suite.ts --desc 的文案（绑定态会在下面追加一句本批状态）
IMPORT_DESC="${MINI_DESC}"

DO_RUN=0
RUNS=1
DRY_RUN=0
REPORT_ONLY=0
RUN_INDEX="${RUN_INDEX:-1}"
TIMEOUT_MIN="${TIMEOUT_MIN:-90}"
REPORT_IDS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run) DO_RUN=1 ;;
    --runs) shift; RUNS="${1:-}" ;;
    --dry-run) DRY_RUN=1 ;;
    --report-only) REPORT_ONLY=1 ;;
    --run-index) shift; RUN_INDEX="${1:-}" ;;
    --run-id) shift; REPORT_IDS+=("${1:-}") ;;
    --timeout-min) shift; TIMEOUT_MIN="${1:-}" ;;
    -h|--help) sed -n '2,21p' "${SELF}"; exit 0 ;;
    *) echo "未知参数：$1（--help 看用法）"; exit 2 ;;
  esac
  shift
done

hr() { printf '\n════════ %s ════════\n' "$1"; }
die() { printf '\n✗ %s\n' "$1" >&2; exit 1; }
isPosInt() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }

isPosInt "${RUNS}" || die "--runs 要一个正整数，收到：${RUNS}"
isPosInt "${RUN_INDEX}" || die "--run-index 要一个正整数，收到：${RUN_INDEX}"
isPosInt "${TIMEOUT_MIN}" || die "--timeout-min 要一个正整数，收到：${TIMEOUT_MIN}"
if [[ "${DRY_RUN}" == "1" && "${DO_RUN}" == "1" ]]; then
  die "--dry-run（不碰平台）和 --run（建 run 并跑）互斥，只能挑一个。"
fi

# --- 报告模式：不构建不导入，只把已有的 run 汇总成报告
if [[ "${REPORT_ONLY}" == "1" ]]; then
  hr "汇总报告（--report-only）"
  if [[ ${#REPORT_IDS[@]} -eq 0 && -f "${RUN_ID_FILE}" ]]; then
    while IFS= read -r line; do
      line="${line//[$'\r\n ']/}"
      if [[ -n "${line}" ]]; then REPORT_IDS+=("${line}"); fi
    done < "${RUN_ID_FILE}"
    if [[ ${#REPORT_IDS[@]} -gt 0 ]]; then
      echo "没给 --run-id，用上一批 --run 记下的 ${#REPORT_IDS[@]} 个 runId（${RUN_ID_FILE}）。"
    else
      echo "${RUN_ID_FILE} 是空的：上一次 --run 没跑到「建 run」那一步（构建/导入就挂了），没有 runId 可报。"
    fi
  fi
  if [[ ${#REPORT_IDS[@]} -eq 0 ]]; then
    die "没有 runId。用法：--report-only --run-id <id> [--run-id <id> ...]；或先跑一次 --run 让它自己记下来。"
  fi
  RARGS=()
  for r in ${REPORT_IDS[@]+"${REPORT_IDS[@]}"}; do RARGS+=(--run "${r}"); done
  BASELINE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${V2}/suite-config.json','utf8')).baseline_run_id||'')")
  if [[ -n "${BASELINE}" ]]; then RARGS+=(--baseline "${BASELINE}"); fi
  echo "runId：${REPORT_IDS[*]}"
  npx tsx "${V2}/scripts/report.ts" ${RARGS[@]+"${RARGS[@]}"}
  echo
  echo "提醒：MINI 只有 16 条，报告里的通过率是**链路冒烟结论**，不能当版本质量结论。要质量结论请跑 ${FULL_SUITE_NAME}。"
  exit 0
fi

# --- 0. 环境自检
hr "0/3 环境与参数"
if [[ ! -f "${ONLY_LIST}" ]]; then
  die "缺 MINI 清单：${ROOT}/${ONLY_LIST}。它是 16 条 case_id 的纯文本（# 开头是注释），build-cases.ts --only 要用。"
fi
if [[ ! -f "${V2}/build-cases.ts" || ! -f "data_scripts/validate-cases.ts" || ! -f "${V2}/scripts/import-suite.ts" ]]; then
  die "脚本不全（build-cases.ts / data_scripts/validate-cases.ts / scripts/import-suite.ts）。确认你在 cortex-eval 仓库里，且仓库根是 ${ROOT}。"
fi
ID_COUNT=$(sed -e 's/#.*$//' -e 's/[[:space:]]//g' "${ONLY_LIST}" | grep -c . || true)
[[ "${ID_COUNT}" -gt 0 ]] || die "${ONLY_LIST} 里一条 case_id 都没有（全被注释掉了？）。"

if [[ -f "${BINDINGS}" ]]; then MODE="bound"; else MODE="draft"; fi

echo "仓库根：${ROOT}"
echo "MINI 清单：${ONLY_LIST}（${ID_COUNT} 条 case_id）"
if [[ "${ID_COUNT}" != "16" ]]; then
  echo "⚠ 清单是 ${ID_COUNT} 条，不是套件名里写的 16 条。改了清单记得同步改 SUITE_NAME 和 README 的清单表。"
fi
echo "目标套件：${SUITE_NAME}（描述取自 ${DESC_SRC}）"
if [[ "${DRY_RUN}" == "1" ]]; then
  echo "模式：--dry-run（草稿态构建 + 平台契约校验，**不导入、不建 run**）"
elif [[ "${MODE}" == "bound" ]]; then
  echo "模式：绑定态（读 ${BINDINGS}），轮次 r${RUN_INDEX}..r$((RUN_INDEX + RUNS - 1))，导入平台$( [[ "${DO_RUN}" == "1" ]] && echo "，并建 run 等它跑完" || echo "，不建 run" )"
else
  echo "模式：未绑定草稿态（没有 ${BINDINGS}）→ 构建 + 校验 + 导入平台，prompt 里是 BIND_REQUIRED_xxx 占位"
  if [[ "${DO_RUN}" == "1" ]]; then
    die "--run 需要绑定态：现在没有 ${BINDINGS}，构建出来的 prompt 是 BIND_REQUIRED_xxx 占位，所有 case 都没有真实 uid/sid，跑起来一定全红。
  先 cp ${V2}/bindings.v2.template.json ${BINDINGS}，按 ${V2}/preflight-todo.md 填 value/filled 和 7 个开关，再跑本脚本 --run。
  只想看结构和断言：bash $0 --dry-run（不碰平台）或 bash $0（导入平台，但别在 UI 上点运行）。"
  fi
  if [[ "${RUNS}" != "1" ]]; then
    die "--runs ${RUNS} 只在绑定态有意义（所有 case 共用 bindings.v2.json 顶层真实 uid/sid，未绑定态没有 run_label）。未绑定态固定构建 1 次。"
  fi
fi
TOTAL=$((RUN_INDEX + RUNS - 1))
if [[ "${MODE}" == "bound" ]]; then
  LABEL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${BINDINGS}','utf8')).run_label||'')")
  [[ -n "${LABEL}" ]] || die "${BINDINGS} 里 run_label 是空的。填一个本轮批次名（形如 0916A），它决定产物目录和报告批次，不参与 sid 生成。"
  echo "run_label：${LABEL}"
  # 已绑定态：给平台描述补一句真话。desc.mini.txt 是按「未绑定预览」写的，填完 bindings 后那句话就过期了，
  # 但脚本不能替你去改文案文件，只能在描述尾部追加本批的真实状态，避免平台上留着一个自相矛盾的警告。
  IMPORT_DESC="${MINI_DESC}｜本批为已绑定构建（run_label=${LABEL}，r${RUN_INDEX}"
  if [[ "${TOTAL}" != "${RUN_INDEX}" ]]; then IMPORT_DESC="${IMPORT_DESC}..r${TOTAL}"; fi
  IMPORT_DESC="${IMPORT_DESC}），占位已替换，所有 case 已注入真实 uid/sid，可以运行。"
  if [[ "${MINI_DESC}" == *"未绑定"* ]]; then
    echo "⚠ ${DESC_SRC} 里还写着「未绑定预览／别跑」，但 ${BINDINGS} 已经在了——那句警告已过期。"
    echo "  本脚本会在导入描述尾部追加「本批为已绑定构建（run_label=${LABEL}，r${RUN_INDEX}..r${TOTAL}）」把状态说清楚；"
    echo "  文案本身请你自己去改 ${MINI}/desc.mini.txt（改完平台描述会在下次导入时自动同步）。"
  fi
  cat <<WARN
⚠ 真实会话提醒：MINI 的所有 case 共用 bindings.v2.json 顶层真实 uid/sid，不能与全集或 WebUI 并发；重复轮次也复用该 sid。
  MINI 与「${FULL_SUITE_NAME}」必须错峰运行；不能依赖 run_label 或 run_index 隔离上下文。
  跑下一轮前先确认 WebUI 会话焦点、历史和所有消耗型前置已恢复。
WARN
else
  IMPORT_DESC="${MINI_DESC}"
fi

# --- 逐轮：构建 → 校验 →（导入）→（建 run）
RUN_IDS=()
# runId 记录文件只在「本批第一次真的要建 run」时才清空：
# 放在循环外清的话，构建阶段一失败就把上一批的 runId 记录抹掉了，--report-only 就没东西可报。
RUN_FILE_RESET=0

for ((N = RUN_INDEX; N <= TOTAL; N++)); do
  if [[ "${DRY_RUN}" == "1" || "${MODE}" == "draft" ]]; then
    CASES="${MINI}/cases.mini.draft.jsonl"
    BUILD_LOG="${LOGDIR}/mini-build-draft.log"
    hr "$( [[ "${DRY_RUN}" == "1" ]] && echo "1/2" || echo "1/3" ) 构建 MINI cases（草稿态，--only ${ID_COUNT} 条）"
    BUILD_ARGS=(--only "${ONLY_LIST}" --out "${CASES}" --allow-dirty)
  else
    CASES="${MINI}/cases.mini.r${N}.jsonl"
    BUILD_LOG="${LOGDIR}/mini-build-r${N}.log"
    hr "第 ${N}/${TOTAL} 轮 · 1/3 构建 MINI cases（绑定态，--only ${ID_COUNT} 条，--run-index ${N}）"
    if [[ -f "${CASES}" ]]; then
      die "${CASES} 已存在。同一个 run_label + run_index 只能构建一次（暗号和产物不能复用；sid 是真实 WebUI 会话）。
  换一轮：--run-index $((N + 1))；确实要覆盖旧产物：手工删掉 ${CASES} 和 ${MINI}/manifest.v2.ready.json 再重跑。"
    fi
    BUILD_ARGS=(--bindings "${BINDINGS}" --only "${ONLY_LIST}" --run-index "${N}" --out "${CASES}")
  fi
  echo "产物：${ROOT}/${CASES}"
  echo "日志：${ROOT}/${BUILD_LOG}"
  set +e
  npx tsx "${V2}/build-cases.ts" ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} 2>&1 | tee "${BUILD_LOG}"
  BUILD_RC=${PIPESTATUS[0]}
  set -e
  if [[ "${BUILD_RC}" != "0" ]]; then
    die "构建失败（退出码 ${BUILD_RC}）。看上面的中文错误行，或 ${BUILD_LOG}。
  常见三种：① --only 清单里有拼错/不存在的 case_id；② 绑定态取值缺失或残留 BIND_REQUIRED；③ 断言装配报错（rules/ 与 scenarios 的 dimensions 对不上）。"
  fi
  if [[ ! -f "${CASES}" ]]; then die "构建说成功了，但产物不见了：${ROOT}/${CASES}"; fi

  hr "$( [[ "${DRY_RUN}" == "1" || "${MODE}" == "draft" ]] && echo "2/2 平台契约校验" || echo "第 ${N}/${TOTAL} 轮 · 2/3 平台契约校验" )"
  if ! npx tsx data_scripts/validate-cases.ts "${CASES}"; then
    die "平台契约校验没过。这是导入前最后一道闸，别绕过它：按上面「第 N 行 · 字段：原因」逐条修。"
  fi

  if [[ "${DRY_RUN}" == "1" ]]; then
    hr "完成（--dry-run：到此为止，没导入平台、没建 run）"
    echo "草稿产物：${ROOT}/${CASES}"
    echo "构建回执：${ROOT}/${MINI}/manifest.v2.draft.json（含子集覆盖率、断言条数、warnings）"
    echo "dry-run 只证明「结构合法、prompt 规则干净、断言条数在约束内」，不证明前置就绪，更不证明 Agent 能跑对。"
    echo "下一步：cp ${V2}/bindings.v2.template.json ${BINDINGS}，按 ${V2}/preflight-todo.md 填好，再跑 bash $0（导入）或 bash $0 --run（导入 + 跑）。"
    exit 0
  fi

  hr "第 ${N}/${TOTAL} 轮 · 3/3 导入平台（整集替换，只动「${SUITE_NAME}」）"
  IMPORT_ARGS=(--cases "${CASES}" --name "${SUITE_NAME}" --desc "${IMPORT_DESC}" --force)
  if ! npx tsx "${V2}/scripts/import-suite.ts" ${IMPORT_ARGS[@]+"${IMPORT_ARGS[@]}"}; then
    die "导入失败。先确认平台在跑（http://127.0.0.1:4310），再看上面的 HTTP 状态码和服务端预检报错。
  受保护的旧套件「飞书功能场景 E2E｜原始33条」脚本层面拒绝写入，不用担心被覆盖。"
  fi
  if [[ "${MODE}" == "draft" ]]; then
    echo "⚠ 导入的是**未绑定预览**：prompt 里含 BIND_REQUIRED_xxx 占位，所有 case 都没有真实 uid/sid。"
    echo "  在平台上只看结构和断言，**不要点运行**（一定全红）。填完 bindings 重跑本脚本会整集替换这 16 条。"
  fi

  if [[ "${DO_RUN}" != "1" ]]; then
    echo "已导入，未建 run（本脚本默认不跑评测）。要跑：bash $0 --run$( [[ "${MODE}" == "bound" ]] && echo "（绑定态已就绪）" || echo "（需要先填 ${BINDINGS}）" )"
    continue
  fi

  hr "第 ${N}/${TOTAL} 轮 · 建 run 并等它跑完（串行，最长等 ${TIMEOUT_MIN} 分钟）"
  if [[ "${RUN_FILE_RESET}" == "0" ]]; then : > "${RUN_ID_FILE}"; RUN_FILE_RESET=1; fi
  RUN_LOG="${LOGDIR}/mini-run-r${N}.log"
  SR_ARGS=(--suite "${SUITE_NAME}" --run-index "${N}" --timeout-min "${TIMEOUT_MIN}")
  if [[ "${MODE}" == "bound" && -n "${LABEL:-}" ]]; then SR_ARGS+=(--label "${LABEL}"); fi
  set +e
  npx tsx "${V2}/scripts/start-runs.ts" ${SR_ARGS[@]+"${SR_ARGS[@]}"} 2>&1 | tee "${RUN_LOG}"
  RUN_RC=${PIPESTATUS[0]}
  set -e
  RID=$(grep -o 'RUN_ID=[0-9a-f-]\{36\}' "${RUN_LOG}" | tail -1 | cut -d= -f2 || true)
  [[ -n "${RID}" ]] || die "没拿到 runId（start-runs 退出码 ${RUN_RC}）。看 ${RUN_LOG}：多半是平台 4310 没起、套件名对不上，或 8080 端点没起。"
  RUN_IDS+=("${RID}")
  echo "${RID}" >> "${RUN_ID_FILE}"
  echo "第 ${N} 轮 runId：${RID}（start-runs 退出码 ${RUN_RC}）"
  if [[ "${RUN_RC}" != "0" && "${N}" -lt "${TOTAL}" ]]; then
    echo "这一轮没正常收尾。后面的轮次继续跑，但结论要打折；不想继续就 Ctrl-C，已完成的 runId 在 ${RUN_ID_FILE}。"
  fi
done

hr "MINI 流水线完成"
echo "套件：${SUITE_NAME}（http://127.0.0.1:4310 里按这个名字找）"
if [[ "${DO_RUN}" == "1" && ${#RUN_IDS[@]} -gt 0 ]]; then
  echo "runId 清单（已记进 ${RUN_ID_FILE}）："
  for r in ${RUN_IDS[@]+"${RUN_IDS[@]}"}; do echo "  ${r}"; done
  echo "出报告：bash $0 --report-only"
  echo
  echo "MINI 的 16 条是**冒烟子集**：37 个评测子项全覆盖，但条数只有全集的 16/55，"
  echo "通过率只能回答「链路通不通、判分口径对不对」，不能当版本质量结论。要质量结论：bash ${V2}/scripts/run-all.sh --auto-reset"
else
  echo "本次没建 run。要跑：bash $0 --run"
fi

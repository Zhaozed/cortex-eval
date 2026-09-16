#!/usr/bin/env python3
"""Read-only preflight under the exact Cortex UID. Never creates fixtures or runs Cases.
Raw responses are private evidence; the concise report contains no tokens/secrets.
An authorization failure is NOT evidence that a document or contact is absent.
"""
import datetime as dt
import json
import pathlib
import sys
import urllib.error
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parent


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value, private=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    if private:
        path.chmod(0o600)


def probe(config, text, folder, name):
    # Python int emits an exact JSON integer, unlike JavaScript Number.
    body = {'uid': int(config['uid']), 'execution_mode': 'isolated',
            'timezone': config['timezone'], 'lang': 'zh-Hans',
            'timeout_ms': 180000, 'text': text}
    write_json(folder / (name + '-request.json'), body, True)
    request = urllib.request.Request(config['endpoint_url'],
        data=json.dumps(body, ensure_ascii=False).encode(),
        headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(request, timeout=220) as response:
        result = json.load(response)
    write_json(folder / (name + '-response.json'), result, True)
    return result


def successes(response, tool):
    p = response.get('parsed_output') or {}
    found = []
    for execution in p.get('tool_executions', []):
        if execution.get('status') != 'SUCCEEDED':
            continue
        for terminal in execution.get('terminals', []):
            result = terminal.get('tool_result') or {}
            if (terminal.get('type') == 'TOOL_RESULT' and result.get('name') == tool
                    and result.get('status') == 'SUCCESS'
                    and result.get('tool_request_id') == execution.get('tool_request_id')):
                found.append(result.get('result'))
    return found


def main():
    if '--help' in sys.argv:
        print('python3 test_suite/feishu-e2e/preflight.py\n只读核对指定UID授权与资源；不会创建前置/改权限/发送消息/运行Case。')
        return 0
    if len(sys.argv) != 1:
        raise SystemExit('No arguments except --help are supported.')
    config = read_json(ROOT / 'suite-config.json')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    folder = ROOT / '.local' / ('preflight-' + stamp + '-' + uuid.uuid4().hex[:6])
    report = {'uid': config['uid'], 'checked_at': dt.datetime.now(dt.timezone.utc).isoformat(),
              'endpoint_id': config['endpoint_id'], 'business_writes': 0,
              'acceptance_cases_executed': 0, 'resources_resolved': False,
              'evidence_directory': str(folder), 'status': 'PREFLIGHT_INCOMPLETE'}
    try:
        auth = probe(config, '飞书功能测试，只读查询：请用飞书工具查询我当前绑定的飞书本人资料，返回实际姓名和open_id。不要修改资源、创建日程或发送消息。', folder, 'identity')
        p = auth.get('parsed_output') or {}
        report['req_id'] = (p.get('request_identity') or {}).get('root_req_id')
        report['route'] = (p.get('route') or {}).get('decision')
        report['feishu_tool_calls'] = len(p.get('tool_executions', []))
        actual_uid = (p.get('request_identity') or {}).get('uid')
        if str(actual_uid) != config['uid']:
            report['status'] = 'BLOCKED_IDENTITY_OR_EVIDENCE'
        elif not auth.get('ok') or not successes(auth, 'feishu_get_user_profile'):
            unauthorized = '\n'.join(str(c.get('system_prompt', '')).split('## 未授权工具', 1)[1].split('## ', 1)[0]
                for c in p.get('llm_calls', []) if '## 未授权工具' in str(c.get('system_prompt', '')))
            report['status'] = ('BLOCKED_FEISHU_AUTHORIZATION' if 'feishu_get_user_profile' in unauthorized
                                else 'BLOCKED_PROFILE_OR_EVIDENCE')
        else:
            result = probe(config, '飞书功能测试只读资源定位：搜索联系人秦宇龙，查找群聊飞书测试群并读取成员；搜索精确标题《飞书测试文档-auto》，如唯一命中则读取完整正文和blocks。列出当前已有可写飞书日历，发现已有真实会议室。多候选全部列出不猜选；仅返回实际名称、ID、URL和可用性，不修改文档，不发送消息、不创建会议或实体会议室。', folder, 'resources')
            required = ['feishu_search_users', 'feishu_list_conversations', 'feishu_list_chat_members',
                        'feishu_search_docs', 'feishu_get_doc', 'feishu_list_calendars']
            report['successful_resource_tools'] = [t for t in required if successes(result, t)]
            report['status'] = 'RESOURCE_EVIDENCE_COLLECTED_NEEDS_BINDING_REVIEW'
            if not result.get('ok') or len(report['successful_resource_tools']) != len(required):
                report['status'] = 'BLOCKED_RESOURCE_DISCOVERY'
            report['note'] = '采集不等于绑定完成：需核对唯一候选、完整正文、真实资源ID、人员授权及房间，再按preparation-plan.json准备fixture。没有自动勾选审核项或解锁导入Case。'
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
        report['status'] = 'BLOCKED_TRANSPORT_OR_EVIDENCE'
        report['error_type'] = type(error).__name__
        report['note'] = '没有进行自动重试；先检查私有证据。'
    write_json(ROOT / 'preflight-report.json', report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'RESOURCE_EVIDENCE_COLLECTED_NEEDS_BINDING_REVIEW' else 2


if __name__ == '__main__':
    raise SystemExit(main())

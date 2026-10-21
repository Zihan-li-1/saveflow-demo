"""Read-only local TrueForge evidence; redact all session IDs and continuation tokens."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3

parser = argparse.ArgumentParser()
parser.add_argument('--since', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--tools', default='transfer_preview', help='Comma-separated allowlist of sessions to inspect')
args = parser.parse_args()
database = Path(os.environ['LOCALAPPDATA']) / 'trueforge/Data/db/db.sqlite'
connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)


def tag(value):
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def redact(value):
    if isinstance(value, dict):
        return {k: ({'present': True, 'sha256Tag': tag(v)} if k == 'continuationToken' and isinstance(v, str) else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        # MCP errors may wrap a JSON result inside error[].text. Redact those
        # credentials too, while retaining the original string representation.
        try:
            nested = json.loads(value)
            if isinstance(nested, (dict, list)):
                return json.dumps(redact(nested), ensure_ascii=False)
        except ValueError:
            pass
    return value


report = {'source': 'real local TrueForge SQLite (read-only)', 'sessions': []}
selected_tools = set(args.tools.split(','))
for sid, spec_raw, agent_name, shared in connection.execute('SELECT session_id,json(agent_spec),agent_name,shared FROM session WHERE created_at>=? ORDER BY created_at', (args.since,)):
    spec = json.loads(spec_raw)
    if not any(selected_tools.intersection(m.get('enable_tools', [])) for m in spec.get('mcp_servers', [])):
        continue
    session = {'sessionTag': tag(sid), 'savedAgentName': agent_name, 'shared': bool(shared), 'model': spec.get('model'), 'mcpServers': spec.get('mcp_servers'), 'events': []}
    report['sessions'].append(session)
    for raw, in connection.execute('SELECT json(event) FROM session_event WHERE session_id=? ORDER BY created_at', (sid,)):
        e = json.loads(raw)
        item = {'type': e['type'], 'at': e.get('created_at')}
        if e['type'] == 'model.message':
            item['content'] = e.get('content')
            item['usage'] = e.get('usage')
            item['toolCalls'] = [{**{k: c[k] for k in ['id', 'tool_info'] if k in c}, 'name': c['function']['name'], 'arguments': redact(json.loads(c['function']['arguments']))} for c in e.get('tool_calls', [])]
        elif e['type'] == 'tool.response':
            item['toolCallId'] = e['tool_call_id']
            try:
                item['result'] = redact(json.loads(e['content']))
            except (ValueError, KeyError):
                item['result'] = '[non-JSON result omitted]'
        elif e['type'] == 'turn.done':
            item['status'] = e['state']['status']
            item['requiredActions'] = [a['type'] for a in e['state'].get('required_actions', [])]
        elif e['type'] == 'turn.created':
            item['turnId'] = e['turn_id']
            item['previousTurnId'] = e.get('previous_turn_id')
            item['userInputs'] = []
            for user_input in e.get('input', []):
                if user_input.get('type') != 'user.message':
                    continue
                try:
                    item['userInputs'].append(redact(json.loads(user_input['content'])))
                except ValueError:
                    item['userInputs'].append(user_input['content'])
        else:
            continue
        session['events'].append(item)
connection.close()
target = Path(args.output)
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'sessions': len(report['sessions']), 'events': sum(len(s['events']) for s in report['sessions']), 'output': str(target)}, ensure_ascii=True))

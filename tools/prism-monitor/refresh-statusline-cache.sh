#!/usr/bin/env bash
# Refreshes /tmp/prism-statusline.cache — invoked detached from statusline-command.sh
PRISM_CACHE="/tmp/prism-statusline.cache"
PRISM_LOCK="/tmp/prism-statusline.lock"
[ -f "$PRISM_LOCK" ] && exit 0
touch "$PRISM_LOCK"
PYTHONIOENCODING=utf-8 python "$HOME/.claude/tools/prism-monitor/prism-monitor.py" --export 2>/dev/null | \
  python -c "
import sys, json, re
raw = sys.stdin.read()
m = re.search(r'\{.*\}', raw, re.S)
if not m:
    print('PRISM n/a'); sys.exit(0)
try:
    d = json.loads(m.group(0))
    sess = d.get('sessions', [])
    tot  = d.get('totals', {})
    turns = sum(s.get('turns', 0) for s in sess)
    mcps  = sum(s.get('mcp_calls', 0) for s in sess)
    cost  = tot.get('cost', 0.0)
    print(f'PRISM {len(sess)}s {turns}t \${cost:.2f} mcp{mcps}')
except Exception:
    print('PRISM err')
" > "$PRISM_CACHE" 2>/dev/null
rm -f "$PRISM_LOCK"

#!/usr/bin/env bash
# Refreshes /tmp/atlas-statusline.cache — invoked detached from statusline-command.sh
ATLAS_CACHE="/tmp/atlas-statusline.cache"
ATLAS_LOCK="/tmp/atlas-statusline.lock"
[ -f "$ATLAS_LOCK" ] && exit 0
touch "$ATLAS_LOCK"
PYTHONIOENCODING=utf-8 python /c/Users/ServosY/.claude/tools/prism-monitor/prism-monitor.py --export 2>/dev/null | \
  python -c "
import sys, json, re
raw = sys.stdin.read()
m = re.search(r'\{.*\}', raw, re.S)
if not m:
    print('ATLAS n/a'); sys.exit(0)
try:
    d = json.loads(m.group(0))
    sess = d.get('sessions', [])
    tot  = d.get('totals', {})
    turns = sum(s.get('turns', 0) for s in sess)
    mcps  = sum(s.get('mcp_calls', 0) for s in sess)
    cost  = tot.get('cost', 0.0)
    print(f'ATLAS {len(sess)}s {turns}t \${cost:.2f} mcp{mcps}')
except Exception:
    print('ATLAS err')
" > "$ATLAS_CACHE" 2>/dev/null
rm -f "$ATLAS_LOCK"

#!/usr/bin/env bash
# Claude Code status line — pure-bash fast path (avoid subprocess fork penalty on Windows).
# Two lines: (1) model + project + git + cost + lines + duration, (2) context bar + PRISM + cwd.
input=$(cat 2>/dev/null)
# Argv fallback (unused on current Claude Code, but cheap)
[ -z "$input" ] && [ -n "$1" ] && input="$1"

# ---------- pure-bash JSON extract (single regex per field, no subprocess) ----------
extract() {
  local key=$1 re val
  re="\"$key\"[[:space:]]*:[[:space:]]*\"?([^,\"}]*)"
  if [[ $input =~ $re ]]; then
    val=${BASH_REMATCH[1]}
    # trim trailing whitespace only (preserve inner spaces like "Opus 4.7")
    val="${val%"${val##*[![:space:]]}"}"
    printf '%s' "$val"
  fi
}

# Context/PRISM fields (custom, injected by PRISM hooks)
used=$(extract used_percentage)
win_size=$(extract context_window_size)
cache_create=$(extract cache_creation_input_tokens)
cache_read=$(extract cache_read_input_tokens)
input_tok=$(extract input_tokens)

# Claude Code native fields
model=$(extract display_name)
model_id=$(extract id)
cwd=$(extract current_dir)
transcript_path=$(extract transcript_path)
cost_usd=$(extract total_cost_usd)
lines_add=$(extract total_lines_added)
lines_rm=$(extract total_lines_removed)
dur_ms=$(extract total_duration_ms)
exceeds_200k=$(extract exceeds_200k_tokens)

# ---------- ANSI colors (catppuccin-mocha-ish) ----------
RST=$'\033[0m'; DIM=$'\033[2m'
MAUVE=$'\033[38;2;203;166;247m'   # model
BLUE=$'\033[38;2;137;180;250m'    # dir
GREEN=$'\033[38;2;166;227;161m'   # git clean / added
YEL=$'\033[38;2;249;226;175m'     # dirty / warn
RED=$'\033[38;2;243;139;168m'     # removed / critical
ORANGE=$'\033[38;2;250;179;135m'  # cost
CYAN=$'\033[38;2;137;220;235m'    # prism / duration
GRAY=$'\033[38;2;166;173;200m'    # separators

SEP=" ${GRAY}|${RST} "

# ---------- model emoji ----------
case "$model" in
  *Opus*)   m_emoji="🧠" ;;
  *Sonnet*) m_emoji="🎵" ;;
  *Haiku*)  m_emoji="⚡" ;;
  *)        m_emoji="🤖" ;;
esac
[ -z "$model" ] && model="?" && m_emoji="🤖"
model_seg="${MAUVE}${m_emoji} ${model}${RST}"

# ---------- short cwd (basename only) ----------
# JSON double-escapes Windows backslashes as \\. Normalize to forward slashes.
cwd="${cwd//\\\\/\/}"
cwd="${cwd//\\/\/}"
cwd_short="${cwd##*/}"
[ -z "$cwd_short" ] && cwd_short="~"
dir_seg="${BLUE}📁 ${cwd_short}${RST}"

# ---------- git info (single call, capped at 1s so it never hangs) ----------
git_seg=""
if [ -n "$cwd" ] && { [ -d "$cwd/.git" ] || [ -f "$cwd/.git" ]; }; then
  gs=$(cd "$cwd" 2>/dev/null && timeout 1 git status -b --porcelain=v1 -unormal 2>/dev/null)
  if [ -n "$gs" ]; then
    branch_line=${gs%%$'\n'*}
    branch_line=${branch_line#\#\# }
    branch=${branch_line%%...*}
    branch=${branch%% *}
    [ -z "$branch" ] && branch="?"
    ahead=0; behind=0
    if [[ $branch_line =~ ahead\ ([0-9]+) ]]; then ahead=${BASH_REMATCH[1]}; fi
    if [[ $branch_line =~ behind\ ([0-9]+) ]]; then behind=${BASH_REMATCH[1]}; fi
    rest=${gs#*$'\n'}
    if [ "$rest" = "$gs" ] || [ -z "$rest" ]; then
      dirty=0
    else
      nl=${rest//[^$'\n']/}
      dirty=$(( ${#nl} + 1 ))
    fi
    if (( dirty > 0 )); then
      g_color=$YEL
      g_dirty="*${dirty}"
    else
      g_color=$GREEN
      g_dirty=""
    fi
    ah_bh=""
    (( ahead > 0 )) && ah_bh+=" ↑${ahead}"
    (( behind > 0 )) && ah_bh+=" ↓${behind}"
    if (( ${#branch} > 28 )); then branch="${branch:0:25}…"; fi
    git_seg="${g_color}⎇ ${branch}${g_dirty}${ah_bh}${RST}"
  fi
fi

# ---------- cost ----------
# Format: 2 decimals by default; 4 decimals only for sub-cent amounts (<$0.01).
cost_seg=""
if [ -n "$cost_usd" ] && [[ $cost_usd =~ ^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$ ]]; then
  # Use printf comparison via awk-free trick: 2-decimal round, then if result is 0.00 and source non-zero, use 4-decimal.
  cost_2=$(printf '%.2f' "$cost_usd" 2>/dev/null) || cost_2="$cost_usd"
  if [[ "$cost_2" == "0.00" ]] && [[ "$cost_usd" != "0" ]] && [[ ! "$cost_usd" =~ ^0(\.0+)?$ ]]; then
    cost_fmt=$(printf '%.4f' "$cost_usd" 2>/dev/null) || cost_fmt="$cost_usd"
  else
    cost_fmt="$cost_2"
  fi
  cost_seg="${ORANGE}\$${cost_fmt}${RST}"
fi

# ---------- lines +/- ----------
lines_seg=""
if [ -n "$lines_add" ] || [ -n "$lines_rm" ]; then
  la=${lines_add:-0}; lr=${lines_rm:-0}
  if [[ $la =~ ^[0-9]+$ ]] && [[ $lr =~ ^[0-9]+$ ]] && (( la > 0 || lr > 0 )); then
    lines_seg="${GREEN}+${la}${RST}${GRAY}/${RST}${RED}-${lr}${RST}"
  fi
fi

# ---------- duration ----------
dur_seg=""
if [ -n "$dur_ms" ] && [[ $dur_ms =~ ^[0-9]+$ ]] && (( dur_ms > 0 )); then
  dur_s=$(( dur_ms / 1000 ))
  if (( dur_s < 60 )); then
    dur_fmt="${dur_s}s"
  elif (( dur_s < 3600 )); then
    dur_fmt="$(( dur_s / 60 ))m$(( dur_s % 60 ))s"
  else
    dur_fmt="$(( dur_s / 3600 ))h$(( (dur_s % 3600) / 60 ))m"
  fi
  dur_seg="${CYAN}⏱ ${dur_fmt}${RST}"
fi

# ---------- line 1 assembly ----------
line1="$model_seg$SEP$dir_seg"
[ -n "$git_seg" ]   && line1="$line1$SEP$git_seg"
[ -n "$cost_seg" ]  && line1="$line1$SEP$cost_seg"
[ -n "$lines_seg" ] && line1="$line1$SEP$lines_seg"
[ -n "$dur_seg" ]   && line1="$line1$SEP$dur_seg"

# ---------- line 2 (existing PRISM + context behavior, preserved) ----------
used_int=${used%.*}
[ -z "$used_int" ] && used_int=0
cache_create=${cache_create:-0}
cache_read=${cache_read:-0}
input_tok=${input_tok:-0}
win_tokens=$(( cache_create + cache_read + input_tok ))
if (( win_tokens >= 1000 )); then
  tok_display="$(( win_tokens / 1000 ))k"
else
  tok_display="$win_tokens"
fi
# Context window detection priority:
#  1) PRISM-injected context_window_size (explicit)
#  2) exceeds_200k_tokens flag from Claude Code (1M tier)
#  3) display_name / model_id contains "1M" / "1m" / "[1m]"
#  4) Haiku / Sonnet / Opus default = 200k
if [ -z "$win_size" ] || ! [[ $win_size =~ ^[0-9]+$ ]]; then
  if [ "$exceeds_200k" = "true" ]; then
    win_size=1000000
  elif [[ "$model $model_id" =~ 1[mM]|\[1m\] ]]; then
    win_size=1000000
  else
    win_size=200000
  fi
fi
win_size_k=$(( win_size / 1000 ))

FLAG="$HOME/.claude/hooks/context-save-needed"
HANDLED="$HOME/.claude/hooks/context-save-handled"
if (( used_int >= 55 )) && [ ! -f "$HANDLED" ] && [ ! -f "$FLAG" ]; then
  : > "$FLAG"
fi
if (( used_int < 10 )); then
  rm -f "$HANDLED" "$FLAG" 2>/dev/null
fi

if   (( used_int >= 80 )); then bar_color=$RED
elif (( used_int >= 55 )); then bar_color=$YEL
else                            bar_color=$GREEN
fi
filled=$(( used_int / 10 ))
(( filled > 10 )) && filled=10
empty=$(( 10 - filled ))
bar=""
for ((i=0; i<filled; i++)); do bar+="█"; done
for ((i=0; i<empty; i++)); do bar+="░"; done

warn=""
(( used_int >= 55 )) && warn=" ${YEL}[!SAVE]${RST}"

# ---------- rate limits (native: rate_limits.five_hour, rate_limits.seven_day) ----------
# Each block: "used_percentage":N,"resets_at":UNIXTS
fh_pct=""; fh_reset=""
if [[ $input =~ \"five_hour\"[^}]*\"used_percentage\":([0-9]+)[^}]*\"resets_at\":([0-9]+) ]]; then
  fh_pct=${BASH_REMATCH[1]}
  fh_reset=${BASH_REMATCH[2]}
fi
sd_pct=""; sd_reset=""
if [[ $input =~ \"seven_day\"[^}]*\"used_percentage\":([0-9]+)[^}]*\"resets_at\":([0-9]+) ]]; then
  sd_pct=${BASH_REMATCH[1]}
  sd_reset=${BASH_REMATCH[2]}
fi

# Format reset time in local timezone. Uses system TZ by default (already
# correct UTC+3 on this machine). Only overrides when STATUSLINE_TZ is set
# AND the target zoneinfo is actually installed — otherwise falls back to
# system to avoid the Git-Bash-on-Windows trap where unknown TZ silently
# becomes UTC.
_tz_cmd=""
if [ -n "$STATUSLINE_TZ" ]; then
  if TZ="$STATUSLINE_TZ" date +%z 2>/dev/null | grep -qE '^[+-][0-9]{4}$' && \
     [ "$(TZ="$STATUSLINE_TZ" date +%z 2>/dev/null)" != "$(TZ=UTC date +%z 2>/dev/null)" -o "$STATUSLINE_TZ" = "UTC" ]; then
    _tz_cmd="TZ=$STATUSLINE_TZ "
  fi
fi
fmt_reset() {
  local ts=$1 now_day reset_day
  [ -z "$ts" ] && return
  now_day=$(eval "${_tz_cmd}date '+%Y%m%d'" 2>/dev/null)
  reset_day=$(eval "${_tz_cmd}date -d @$ts '+%Y%m%d'" 2>/dev/null)
  if [ "$now_day" = "$reset_day" ]; then
    eval "${_tz_cmd}date -d @$ts '+%H:%M'" 2>/dev/null
  else
    eval "${_tz_cmd}date -d @$ts '+%a %H:%M'" 2>/dev/null
  fi
}
fh_reset_fmt=$(fmt_reset "$fh_reset")
sd_reset_fmt=$(fmt_reset "$sd_reset")

# Color by usage: <60 green, 60-84 yellow, >=85 red
rl_color() {
  local p=${1:-0}
  if   (( p >= 85 )); then printf '%s' "$RED"
  elif (( p >= 60 )); then printf '%s' "$YEL"
  else                     printf '%s' "$GREEN"
  fi
}
rl_seg=""
if [ -n "$fh_pct" ]; then
  c=$(rl_color "$fh_pct")
  rl_seg+="${c}5h ${fh_pct}% →${fh_reset_fmt}${RST}"
fi
if [ -n "$sd_pct" ]; then
  c=$(rl_color "$sd_pct")
  [ -n "$rl_seg" ] && rl_seg+="$SEP"
  rl_seg+="${c}7d ${sd_pct}% →${sd_reset_fmt}${RST}"
fi

# ---------- line 2: ctx bar + rate limits ----------
line2="ctx ${bar_color}[${bar}]${RST} ${used_int}% ${tok_display}/${win_size_k}k${warn}"
[ -n "$rl_seg" ] && line2="${line2}${SEP}${rl_seg}"

# ---------- optional line 3: MCP servers (only if project .mcp.json has any) ----------
line3=""
mcp_json="$cwd/.mcp.json"
if [ -f "$mcp_json" ]; then
  # Extract server names from "mcpServers":{"name1":{...},"name2":{...}}
  mcp_names=""
  mcp_block=""
  if [[ $(cat "$mcp_json" 2>/dev/null) =~ \"mcpServers\"[[:space:]]*:[[:space:]]*\{([^{}]*(\{[^{}]*\}[^{}]*)*)\} ]]; then
    mcp_block="${BASH_REMATCH[1]}"
  fi
  if [ -n "$mcp_block" ]; then
    # Pull top-level keys "name":{
    tmp="$mcp_block"
    while [[ $tmp =~ \"([a-zA-Z0-9_-]+)\"[[:space:]]*:[[:space:]]*\{ ]]; do
      n="${BASH_REMATCH[1]}"
      [ -n "$mcp_names" ] && mcp_names+=", "
      mcp_names+="$n"
      # advance past this match
      tmp="${tmp#*\"$n\"*\{}"
    done
  fi
  if [ -n "$mcp_names" ]; then
    line3="${MAUVE}🔌 mcp:${RST} ${mcp_names}"
  fi
fi

# ---------- optional line 4: subagent breakdown (tokens + cost per subagent) ----------
# Uses detached async refresh via ~/.claude/tools/subagent-summary.py so the
# statusline itself never blocks on transcript parsing.
line4=""
# Normalize Windows escapes: "C:\\Users\\..." -> "C:/Users/..."
tp="${transcript_path//\\\\/\/}"
tp="${tp//\\/\/}"
if [ -n "$tp" ] && [ -f "$tp" ]; then
  SUB_CACHE="/tmp/subagent-summary.cache"
  SUB_LOCK="/tmp/subagent-summary.lock"
  SUB_TTL=15
  now_ts=$EPOCHSECONDS
  cache_mtime=0
  tr_mtime=0
  [ -f "$SUB_CACHE" ] && cache_mtime=$(stat -c %Y "$SUB_CACHE" 2>/dev/null || echo 0)
  tr_mtime=$(stat -c %Y "$tp" 2>/dev/null || echo 0)
  # Purge stale lock (older than 30s) so a crashed refresh can never wedge the cache
  if [ -f "$SUB_LOCK" ]; then
    lock_mtime=$(stat -c %Y "$SUB_LOCK" 2>/dev/null || echo 0)
    (( now_ts - lock_mtime > 30 )) && rm -f "$SUB_LOCK"
  fi
  # Refresh if cache missing/old OR transcript newer than cache
  if { [ ! -f "$SUB_CACHE" ] || (( now_ts - cache_mtime > SUB_TTL )) || (( tr_mtime > cache_mtime )); } && [ ! -f "$SUB_LOCK" ]; then
    (
      : > "$SUB_LOCK"
      python ~/.claude/tools/subagent-summary.py "$tp" --max 5 --out "$SUB_CACHE" >/dev/null 2>&1
      rm -f "$SUB_LOCK"
    ) &
    disown 2>/dev/null
  fi
  # Read cache (may be empty on first render before refresh completes)
  if [ -s "$SUB_CACHE" ]; then
    subs=""
    while IFS='|' read -r stype smodel stok sdur; do
      [ -z "$stype" ] && continue
      [ -n "$subs" ] && subs+="$SEP"
      subs+="${MAUVE}${stype}${RST} ${DIM}(${smodel})${RST} ${CYAN}${stok}${RST} ${GREEN}${sdur}${RST}"
    done < "$SUB_CACHE"
    [ -n "$subs" ] && line4="🤖 ${subs}"
  fi
fi

# ---------- output ----------
out="$line1"$'\n'"$line2"
[ -n "$line3" ] && out="$out"$'\n'"$line3"
[ -n "$line4" ] && out="$out"$'\n'"$line4"
printf '%s' "$out"

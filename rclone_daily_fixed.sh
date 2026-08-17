#!/bin/bash
set -Eeuo pipefail
umask 022
export TZ=Asia/Seoul

RCLONE="/usr/bin/rclone"
STATUS_DIR="/var/www/rclone-status"
STATUS_FILE="$STATUS_DIR/status.json"
CONFIG_FILE="$STATUS_DIR/config.json"
mkdir -p "$STATUS_DIR"

ts() { date -Is; }

init_status() {
  if [ ! -f "$STATUS_FILE" ] || ! jq . "$STATUS_FILE" >/dev/null 2>&1; then
    echo "{\"last_run\":\"$(ts)\",\"overall\":\"success\",\"details\":[],\"mounts\":[]}" > "$STATUS_FILE"
    chown www-data:www-data "$STATUS_FILE"
  fi
}

update_task_status() {
  local name="$1"; local status="$2"; local logfile="$3"
  init_status
  local tmp_file; tmp_file=$(mktemp)
  jq --arg name "$name" --arg status "$status" --arg log "$logfile" --arg ts "$(ts)"     '(.details[] | select(.task == $name) | .status) = $status |
     (.details[] | select(.task == $name) | .log) = $log |
     if (.details | any(.task == $name)) then . else .details += [{"task":$name, "status":$status, "log":$log}] end |
     .last_run = $ts |
     .overall = (if (.details | any(.status == "error")) then "error"
                 elif (.details | any(.status == "running")) then "running"
                 else "success" end)'     "$STATUS_FILE" > "$tmp_file" && mv "$tmp_file" "$STATUS_FILE"
  chown www-data:www-data "$STATUS_FILE"
}

update_mounts() {
  local paths=("$@"); local mounts_json="[]"
  for p in "${paths[@]}"; do
    local exists="false" mounted="false" source="" fstype="" opts=""
    if [[ -d "$p" ]]; then
      exists="true"
      if findmnt -no SOURCE --target "$p" >/dev/null 2>&1; then
        mounted="true"
        source="$(findmnt -no SOURCE --target "$p" 2>/dev/null || echo "")"
        fstype="$(findmnt -no FSTYPE --target "$p" 2>/dev/null || echo "")"
        opts="$(findmnt -no OPTIONS --target "$p" 2>/dev/null || echo "")"
      fi
    fi
    local item; item=$(jq -n --arg p "$p" --arg e "$exists" --arg m "$mounted" --arg s "$source" --arg f "$fstype" --arg o "$opts"       '{path:$p, exists:($e=="true"), mounted:($m=="true"), source:$s, fstype:$f, opts:$o}')
    mounts_json=$(echo "$mounts_json" | jq --argjson item "$item" '. += [$item]')
  done
  init_status
  local tmp_file; tmp_file=$(mktemp)
  jq --argjson mounts "$mounts_json" '.mounts = $mounts' "$STATUS_FILE" > "$tmp_file" && mv "$tmp_file" "$STATUS_FILE"
  chown www-data:www-data "$STATUS_FILE"
}

run_copy () {
  local name="$1"; local logfile="$2"; shift 2
  local task_lock="/tmp/rclone_task_${name}.lock"
  if [ -f "$task_lock" ]; then
    local pid; pid=$(cat "$task_lock")
    if kill -0 "$pid" 2>/dev/null; then
      echo "[$(ts)] Task $name already running (PID $pid). Skipping."; return 1
    fi
  fi
  echo $$ > "$task_lock"; trap 'rm -f "$task_lock"' RETURN
  pkill -9 -f "rc-addr localhost:5572" 2>/dev/null || true
  for i in $(seq 1 30); do
    if ! ss -tlnp 2>/dev/null | grep -q '127.0.0.1:5572'; then break; fi
    sleep 2
  done
  echo "[$(ts)] START $name" >> "$logfile" 2>&1 || true
  update_task_status "$name" "running" "$logfile"
  if "$@" >> "$logfile" 2>&1; then
    update_task_status "$name" "success" "$logfile"
    echo "[$(ts)] DONE  $name (OK)" >> "$logfile" 2>&1 || true
  else
    update_task_status "$name" "error" "$logfile"
    echo "[$(ts)] FAIL  $name (ERR)" >> "$logfile" 2>&1 || true
  fi
  tail -n 100 "$logfile" > "$STATUS_DIR/${name}.tail" 2>/dev/null || true
}


# _tick mode: config.json의 task schedule이 현재 시각과 매치하면 그 task 1개만 백그라운드 실행
if [ "${1:-}" = "_tick" ]; then
  if [ ! -f "$CONFIG_FILE" ]; then exit 0; fi
  NOW_M=$(date +%M)
  NOW_H=$(date +%H)
  NOW_DOM=$(date +%d)
  NOW_MO=$(date +%m)
  NOW_DOW=$(date +%u)
  field_in_range() {
    local n="$1" lo="${2%-}" hi="${2#*-}"
    (( 10#$n >= 10#$lo && 10#$n <= 10#$hi ))
  }
  match_field() {
    local expr="$1" now="$2"
    case "$expr" in
      "*"|"*/1") return 0 ;;
      */*) local step="${expr#*/}"; [[ $(( 10#$now % 10#$step )) -eq 0 ]] ;;
      *,*) local IFS=','
        for v in $expr; do
          if [[ "$v" == "$now" ]] || { [[ "$v" == *-* ]] && field_in_range "$now" "$v"; }; then return 0; fi
        done
        return 1 ;;
      *-*) field_in_range "$now" "$expr" ;;
      *) expr_p=$(printf '%02d' "$((10#$expr))" 2>/dev/null || echo "$expr")
        now_p=$(printf '%02d' "$((10#$now))" 2>/dev/null || echo "$now")
        [[ "$expr_p" == "$now_p" ]] ;;
    esac
  }
  while IFS=$'\t' read -r tid schedule enabled; do
    [[ "$enabled" == "true" ]] || continue
    read -r sm sh sdom smo sdow <<< "$schedule"
    [[ "$sdow" == "0" ]] && sdow="7"
    match_field "$sm"   "$NOW_M"   || continue
    match_field "$sh"   "$NOW_H"   || continue
    match_field "$sdom" "$NOW_DOM" || continue
    match_field "$smo"  "$NOW_MO"  || continue
    match_field "$sdow" "$NOW_DOW" || continue
    echo "[$(date -Is)] tick -> $tid ($schedule)"
    nohup "$0" "$tid" >/dev/null 2>&1 &
  done < <(jq -r '.tasks[] | [.id, .schedule // "0 3 * * *", (.enabled // true | tostring)] | @tsv' "$CONFIG_FILE")
  exit 0
fi

# config.json에서 마운트 경로 로드
if [ -f "$CONFIG_FILE" ]; then
  SRC_PATHS=($(jq -r '.tasks[].source' "$CONFIG_FILE"))
  update_mounts "${SRC_PATHS[@]}"
fi

if [ $# -gt 0 ]; then
  if [ "$1" = "_update_status" ]; then
    update_task_status "$2" "$3" "$4"; exit 0
  fi
  task_id="$1"
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "Config file not found!"; exit 1
  fi
  task_json=$(jq --arg id "$task_id" '.tasks[] | select(.id == $id)' "$CONFIG_FILE")
  if [ -z "$task_json" ]; then
    echo "Task $task_id not found in config!"; exit 1
  fi
  source=$(echo "$task_json" | jq -r '.source')
  dest=$(echo "$task_json" | jq -r '.dest')
  rclone_flags=$(echo "$task_json" | jq -r '.rclone_flags // ""')
  logfile="/var/log/rclone_${task_id}.log"
  IFS=' ' read -r -a flags_arr <<< "$rclone_flags"
  run_copy "$task_id" "$logfile" "$RCLONE" copy "$source" "$dest" "${flags_arr[@]}"     --contimeout 10s --timeout 1m --retries 3 --retries-sleep 10s     --log-file="$logfile" --log-level=INFO     --rc --rc-no-auth --rc-addr localhost:5572
else
  if [ -f "$CONFIG_FILE" ]; then
    active_tasks=($(jq -r '.tasks[] | select(.enabled == true) | .id' "$CONFIG_FILE"))
    for t in "${active_tasks[@]}"; do
      $0 "$t"; sleep 2
    done
  fi
fi

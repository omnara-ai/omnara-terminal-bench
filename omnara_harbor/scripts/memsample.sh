#!/bin/sh
out=/tmp/omnara/mem.log
echo "# ts cgroup_bytes omnarad_kb omnarad_procs other_kb memavail_kb top_kb top_cmd" >>"$out"
while :; do
  om=0; omn=0; other=0; top=0; topcmd=-
  for p in /proc/[0-9]*; do
    rss=$(sed -n 's/^VmRSS:[[:space:]]*\([0-9]*\).*/\1/p' "$p/status" 2>/dev/null)
    [ -n "$rss" ] || continue
    cmd=$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null | cut -c1-80)
    case "$cmd" in
      *omnarad*) om=$((om + rss)); omn=$((omn + 1)) ;;
      *) other=$((other + rss)) ;;
    esac
    if [ "$rss" -gt "$top" ]; then top=$rss; topcmd=$(echo "$cmd" | tr ' ' '_'); fi
  done
  cg=$(cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null || echo -)
  avail=$(sed -n 's/^MemAvailable:[[:space:]]*\([0-9]*\).*/\1/p' /proc/meminfo 2>/dev/null)
  echo "$(date +%s) $cg $om $omn $other ${avail:--} $top $topcmd" >>"$out"
  sleep 5
done

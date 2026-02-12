#!/usr/bin/env bash
# Nia Sources — unified source management (benchmark mode: read-only)
# Usage: sources.sh <command> [args...]
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

# ─── DISABLED: indexing is handled by the benchmark harness ───────────────────
cmd_index() {
  echo "Error: Indexing is disabled. All documentation sources are already pre-indexed."
  echo "Run 'sources.sh list' to see available sources."
  return 1
}

cmd_subscribe() {
  echo "Error: Subscribing is disabled. All sources are already pre-indexed."
  echo "Run 'sources.sh list' to see available sources."
  return 1
}

cmd_delete() {
  echo "Error: Deleting sources is disabled in benchmark mode."
  return 1
}

cmd_sync() {
  echo "Error: Syncing sources is disabled in benchmark mode."
  return 1
}

cmd_update() {
  echo "Error: Updating sources is disabled in benchmark mode."
  return 1
}

cmd_rename() {
  echo "Error: Renaming sources is disabled in benchmark mode."
  return 1
}

cmd_assign_category() {
  echo "Error: Assigning categories is disabled in benchmark mode."
  return 1
}

# ─── list — list all indexed sources, optionally filtered by type
cmd_list() {
  local type="${1:-}"
  local url="$BASE_URL/sources"
  if [ -n "$type" ]; then url="${url}?type=${type}"; fi
  nia_get "$url"
}

# ─── get — fetch full details for a single source by ID
cmd_get() {
  if [ -z "$1" ]; then echo "Usage: sources.sh get <source_id> [type]"; return 1; fi
  local sid=$(urlencode "$1") type="${2:-}"
  local url="$BASE_URL/sources/${sid}"
  if [ -n "$type" ]; then url="${url}?type=${type}"; fi
  nia_get "$url"
}

# ─── resolve — look up a source by name, URL, or identifier
cmd_resolve() {
  if [ -z "$1" ]; then echo "Usage: sources.sh resolve <identifier> [type]"; return 1; fi
  local id=$(echo "$1" | sed 's/ /%20/g') type="${2:-}"
  local url="$BASE_URL/sources/resolve?identifier=${id}"
  if [ -n "$type" ]; then url="${url}&type=${type}"; fi
  nia_get "$url"
}

# ─── read — read file content from an indexed source by path and optional line range
cmd_read() {
  if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: sources.sh read <source_id> <path> [line_start] [line_end]"
    echo "  MAX_LENGTH  Max characters to return (100-100000)"
    return 1
  fi
  local sid=$(urlencode "$1") path=$(echo "$2" | sed 's/ /%20/g')
  local url="$BASE_URL/data-sources/${sid}/read?path=${path}"
  if [ -n "${3:-}" ]; then url="${url}&line_start=$3"; fi
  if [ -n "${4:-}" ]; then url="${url}&line_end=$4"; fi
  if [ -n "${MAX_LENGTH:-}" ]; then url="${url}&max_length=${MAX_LENGTH}"; fi
  nia_get_raw "$url" | jq -r '.content // .'
}

# ─── grep — regex search across all files in a source
cmd_grep() {
  if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: sources.sh grep <source_id> <pattern> [path]"
    echo "  Env: CASE_SENSITIVE, WHOLE_WORD, FIXED_STRING, OUTPUT_MODE,"
    echo "       HIGHLIGHT, EXHAUSTIVE, LINES_AFTER, LINES_BEFORE, MAX_PER_FILE, MAX_TOTAL"
    return 1
  fi
  local sid=$(urlencode "$1")
  DATA=$(build_grep_json "$2" "${3:-}")
  nia_post "$BASE_URL/data-sources/${sid}/grep" "$DATA"
}

# ─── tree — print the full file tree of a source
cmd_tree() {
  if [ -z "$1" ]; then echo "Usage: sources.sh tree <source_id>"; return 1; fi
  local sid=$(urlencode "$1")
  nia_get_raw "$BASE_URL/data-sources/${sid}/tree" | jq '.tree_string // .'
}

# ─── ls — list files/dirs in a specific path within a source
cmd_ls() {
  if [ -z "$1" ]; then echo "Usage: sources.sh ls <source_id> [path]"; return 1; fi
  local sid=$(echo "$1" | jq -Rr @uri) dir=$(echo "${2:-/}" | jq -Rr @uri)
  nia_get "$BASE_URL/data-sources/${sid}/ls?path=${dir}"
}

# ─── classification — get the auto-classification for a source (read-only)
cmd_classification() {
  if [ -z "$1" ]; then echo "Usage: sources.sh classification <source_id> [type]"; return 1; fi
  local sid=$(urlencode "$1") type="${2:-}"
  local url="$BASE_URL/sources/${sid}/classification"
  if [ -n "$type" ]; then url="${url}?type=${type}"; fi
  nia_get "$url"
}

# ─── dispatch ─────────────────────────────────────────────────────────────────
case "${1:-}" in
  index)            shift; cmd_index "$@" ;;
  list)             shift; cmd_list "$@" ;;
  get)              shift; cmd_get "$@" ;;
  resolve)          shift; cmd_resolve "$@" ;;
  update)           shift; cmd_update "$@" ;;
  delete)           shift; cmd_delete "$@" ;;
  sync)             shift; cmd_sync "$@" ;;
  rename)           shift; cmd_rename "$@" ;;
  subscribe)        shift; cmd_subscribe "$@" ;;
  read)             shift; cmd_read "$@" ;;
  grep)             shift; cmd_grep "$@" ;;
  tree)             shift; cmd_tree "$@" ;;
  ls)               shift; cmd_ls "$@" ;;
  classification)   shift; cmd_classification "$@" ;;
  assign-category)  shift; cmd_assign_category "$@" ;;
  *)
    echo "Usage: $(basename "$0") <command> [args...]"
    echo ""
    echo "Commands (read-only — all sources are pre-indexed):"
    echo "  list [type]      List sources (repo|documentation)"
    echo "  get              Get source details"
    echo "  resolve          Resolve source by name/URL"
    echo "  read             Read content from a source"
    echo "  grep             Search source content with regex"
    echo "  tree             Get source file tree"
    echo "  ls               List directory in source"
    echo "  classification   Get source classification"
    exit 1
    ;;
esac

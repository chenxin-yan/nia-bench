#!/usr/bin/env bash
# Nia Search — query, universal (benchmark mode: no web/deep)
# Usage: search.sh <command> [args...]
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/lib.sh"

# ─── query — AI-powered search across specific repos, docs, or local folders
cmd_query() {
  if [ -z "$1" ]; then
    echo "Usage: search.sh query <query> <repos_csv> [docs_csv]"
    echo "  Env: LOCAL_FOLDERS, CATEGORY, MAX_TOKENS"
    return 1
  fi
  local query="$1" repos="${2:-}" docs="${3:-}"
  if [ -n "$repos" ]; then
    REPOS_JSON=$(echo "$repos" | tr ',' '\n' | jq -R '.' | jq -s 'map({repository: .})')
  else REPOS_JSON="[]"; fi
  if [ -n "$docs" ]; then
    DOCS_JSON=$(echo "$docs" | tr ',' '\n' | jq -R '.' | jq -s '.')
  else DOCS_JSON="[]"; fi
  if [ -n "${LOCAL_FOLDERS:-}" ]; then
    FOLDERS_JSON=$(echo "$LOCAL_FOLDERS" | tr ',' '\n' | jq -R '.' | jq -s '.')
  else FOLDERS_JSON="[]"; fi
  # Auto-detect search mode
  if [ -n "$repos" ] && [ -z "$docs" ]; then MODE="repositories"
  elif [ -z "$repos" ] && [ -n "$docs" ]; then MODE="sources"
  else MODE="unified"; fi
  DATA=$(jq -n \
    --arg q "$query" --arg mode "$MODE" \
    --argjson repos "$REPOS_JSON" --argjson docs "$DOCS_JSON" --argjson folders "$FOLDERS_JSON" \
    --arg cat "${CATEGORY:-}" --arg mt "${MAX_TOKENS:-}" \
    '{mode: "query", messages: [{role: "user", content: $q}], repositories: $repos,
     data_sources: $docs, search_mode: $mode, stream: false, include_sources: true}
    + (if ($folders | length) > 0 then {local_folders: $folders} else {} end)
    + (if $cat != "" then {category: $cat} else {} end)
    + (if $mt != "" then {max_tokens: ($mt | tonumber)} else {} end)')
  nia_post "$BASE_URL/search" "$DATA"
}

# ─── DISABLED: web search and deep research are not needed ────────────────────
cmd_web() {
  echo "Error: Web search is disabled. All sources are already pre-indexed."
  echo "Use 'search.sh query' or 'search.sh universal' to search indexed sources."
  return 1
}

cmd_deep() {
  echo "Error: Deep research is disabled. All sources are already pre-indexed."
  echo "Use 'search.sh query' or 'search.sh universal' to search indexed sources."
  return 1
}

# ─── universal — hybrid semantic+keyword search across all your indexed sources
cmd_universal() {
  if [ -z "$1" ]; then
    echo "Usage: search.sh universal <query> [top_k]"
    echo "  Env: INCLUDE_REPOS, INCLUDE_DOCS, INCLUDE_HF, ALPHA, COMPRESS,"
    echo "       MAX_TOKENS, BOOST_LANGUAGES, LANGUAGE_BOOST, EXPAND_SYMBOLS, NATIVE_BOOSTING"
    return 1
  fi
  DATA=$(jq -n \
    --arg q "$1" --argjson k "${2:-20}" \
    --arg ir "${INCLUDE_REPOS:-true}" --arg id "${INCLUDE_DOCS:-true}" \
    --arg ihf "${INCLUDE_HF:-}" --arg alpha "${ALPHA:-}" \
    --arg compress "${COMPRESS:-false}" --arg mt "${MAX_TOKENS:-}" \
    --arg bl "${BOOST_LANGUAGES:-}" --arg lbf "${LANGUAGE_BOOST:-}" \
    --arg es "${EXPAND_SYMBOLS:-}" --arg nb "${NATIVE_BOOSTING:-}" \
    '{mode: "universal", query: $q, top_k: $k,
     include_repos: ($ir == "true"), include_docs: ($id == "true"),
     compress_output: ($compress == "true")}
    + (if $ihf != "" then {include_huggingface_datasets: ($ihf == "true")} else {} end)
    + (if $alpha != "" then {alpha: ($alpha | tonumber)} else {} end)
    + (if $mt != "" then {max_tokens: ($mt | tonumber)} else {} end)
    + (if $bl != "" then {boost_languages: ($bl | split(","))} else {} end)
    + (if $lbf != "" then {language_boost_factor: ($lbf | tonumber)} else {} end)
    + (if $es != "" then {expand_symbols: ($es == "true")} else {} end)
    + (if $nb != "" then {use_native_boosting: ($nb == "true")} else {} end)')
  nia_post "$BASE_URL/search" "$DATA"
}

# ─── dispatch ─────────────────────────────────────────────────────────────────
case "${1:-}" in
  query)     shift; cmd_query "$@" ;;
  web)       shift; cmd_web "$@" ;;
  deep)      shift; cmd_deep "$@" ;;
  universal) shift; cmd_universal "$@" ;;
  *)
    echo "Usage: $(basename "$0") <command> [args...]"
    echo ""
    echo "Commands (all sources are pre-indexed):"
    echo "  query      Query specific repos/sources with AI"
    echo "  universal  Search across all indexed sources"
    exit 1
    ;;
esac

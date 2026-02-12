---
slug: nia
name: Nia
description: Search pre-indexed code repositories and documentation with Nia AI. All sources are already indexed — use list, search, read, and grep tools to find the APIs you need.
homepage: https://trynia.ai
---

# Nia Skill (Benchmark Mode)

Direct API access to [Nia](https://trynia.ai) for searching pre-indexed code repositories and documentation.

Nia provides tools for searching external repositories, documentation, and packages. Its primary goal is to reduce hallucinations in LLMs and provide up-to-date context for AI agents.

> **All documentation sources and repositories required for this task are already indexed.** Do NOT attempt to index, subscribe, create, delete, or modify any sources. These operations are disabled.

## Setup

The `NIA_API_KEY` environment variable is already configured.

### Requirements

- `curl`
- `jq`

## Benchmark Workflow

Follow this workflow to find the documentation you need:

1. **List available sources**: Run `./scripts/sources.sh list` and/or `./scripts/repos.sh list` to see all pre-indexed documentation and repositories.
2. **Find the matching source**: Identify the source that matches the library and version specified in the task.
3. **Search for APIs**: Use `search.sh query` with the source ID/name and a query describing the APIs you need, or use `search.sh universal` to search across all indexed sources.
4. **Drill into specifics**: Use `sources.sh read` / `sources.sh grep` or `repos.sh read` / `repos.sh grep` to look up exact usage patterns, function signatures, and examples.
5. **Write code**: Only after reviewing the returned documentation should you write code.

**Important**: Do NOT rely on your training knowledge alone. Always verify API signatures and patterns against the indexed documentation.

## Scripts

All scripts are in `./scripts/` and use `lib.sh` for shared auth/curl helpers. Base URL: `https://apigcp.trynia.ai/v2`

Each script uses subcommands: `./scripts/<script>.sh <command> [args...]`
Run any script without arguments to see available commands and usage.

### sources.sh — Documentation Source Search

```bash
./scripts/sources.sh list [type]                                  # List sources (documentation|repository)
./scripts/sources.sh get <source_id> [type]                       # Get source details
./scripts/sources.sh resolve <identifier> [type]                  # Resolve name/URL to ID
./scripts/sources.sh read <source_id> <path> [line_start] [end]   # Read content
./scripts/sources.sh grep <source_id> <pattern> [path]            # Grep content
./scripts/sources.sh tree <source_id>                             # Get file tree
./scripts/sources.sh ls <source_id> [path]                        # List directory
```

**Grep environment variables**: `CASE_SENSITIVE`, `WHOLE_WORD`, `FIXED_STRING`, `OUTPUT_MODE`, `HIGHLIGHT`, `EXHAUSTIVE`, `LINES_AFTER`, `LINES_BEFORE`, `MAX_PER_FILE`, `MAX_TOTAL`

**Flexible identifiers**: Most endpoints accept UUID, display name, or URL:
- UUID: `550e8400-e29b-41d4-a716-446655440000`
- Display name: `Vercel AI SDK - Core`, `openai/gsm8k`
- URL: `https://docs.trynia.ai/`, `https://arxiv.org/abs/2312.00752`

### repos.sh — Repository Search

```bash
./scripts/repos.sh list                                          # List indexed repos
./scripts/repos.sh status <owner/repo>                           # Get repo status
./scripts/repos.sh read <owner/repo> <path/to/file>              # Read file
./scripts/repos.sh grep <owner/repo> <pattern> [path_prefix]     # Grep code (REF= for branch)
./scripts/repos.sh tree <owner/repo> [branch]                    # Get file tree
```

**Tree environment variables**: `INCLUDE_PATHS`, `EXCLUDE_PATHS`, `FILE_EXTENSIONS`, `EXCLUDE_EXTENSIONS`, `SHOW_FULL_PATHS`

### search.sh — Search

```bash
./scripts/search.sh query <query> <repos_csv> [docs_csv]         # Query specific repos/sources
./scripts/search.sh universal <query> [top_k]                    # Search ALL indexed sources
```

**query** — targeted search with AI response and sources. Env: `LOCAL_FOLDERS`, `CATEGORY`, `MAX_TOKENS`
**universal** — hybrid vector + BM25 across all indexed sources. Env: `INCLUDE_REPOS`, `INCLUDE_DOCS`, `INCLUDE_HF`, `ALPHA`, `COMPRESS`, `MAX_TOKENS`, `BOOST_LANGUAGES`, `EXPAND_SYMBOLS`

### packages.sh — Package Source Code Search

```bash
./scripts/packages.sh grep <registry> <package> <pattern> [ver]  # Grep package code
./scripts/packages.sh hybrid <registry> <package> <query> [ver]  # Semantic search
./scripts/packages.sh read <reg> <pkg> <sha256> <start> <end>    # Read file lines
```

Registry: `npm` | `py_pi` | `crates_io` | `golang_proxy`
Grep env: `LANGUAGE`, `CONTEXT_BEFORE`, `CONTEXT_AFTER`, `OUTPUT_MODE`, `HEAD_LIMIT`, `FILE_SHA256`
Hybrid env: `PATTERN` (regex pre-filter), `LANGUAGE`, `FILE_SHA256`

## API Reference

- **Base URL**: `https://apigcp.trynia.ai/v2`
- **Auth**: Bearer token in Authorization header
- **Flexible identifiers**: Most endpoints accept UUID, display name, or URL

### Search Modes

For `search.sh query`:
- `repositories` — Search GitHub repositories only (auto-detected when only repos passed)
- `sources` — Search data sources only (auto-detected when only docs passed)
- `unified` — Search both (default when both passed)

Pass sources via:
- `repositories` arg: comma-separated `"owner/repo,owner2/repo2"`
- `data_sources` arg: comma-separated `"display-name,uuid,https://url"`

---
description: Odysseus codebase architecture map from graphify dependency graph
tags: [architecture, dependencies, graph]
---

# Odysseus Architecture (auto-generated from graphify)

## Scale
- 16,935 symbols · 34,980 dependency links · 763 communities
- Built from commit `6d365fd6`

## Key Files by Symbol Density (most connected/complex)
| File | Symbols | Role |
|------|---------|------|
| `static/js/vaultPanel.js` | 267 | Vault UI panel, note browsing, graph view, breadcrumbs |
| `static/js/document.js` | 245 | Document editor, markdown rendering |
| `core/database.py` | 191 | SQLite ORM, persistence layer |
| `static/js/slashCommands.js` | 151 | Command palette, slash commands |
| `static/js/notes.js` | 146 | Note management, CRUD |
| `static/js/obsidianShim.js` | 145 | Obsidian compatibility layer |
| `static/js/emailLibrary.js` | 139 | Email integration |
| `src/llm_core.py` | 132 | LLM orchestration, model routing |
| `static/js/galleryEditor.js` | 121 | Media gallery, image handling |
| `src/tool_implementations.py` | 106 | Tool/plugin implementations |
| `mcp_servers/email_server.py` | 99 | MCP email server |

## Backend Structure
- **Routes** (`routes/`): API endpoints, vault notes, admin, auth
- **Core** (`core/`): Database models, config, security
- **Src** (`src/`): LLM core, vault graph, vault watcher, tool implementations
- **MCP Servers** (`mcp_servers/`): External tool integrations (email, etc.)

## Frontend Structure
- **static/js/**: Main app logic, vault UI, document editor, gallery
- **static/css/**: Stylesheets including vault-specific styles
- **static/lib/**: Third-party libraries (docx, mammoth, etc.)

## Vault Subsystem (most active development area)
- Frontend: `vaultPanel.js` (tabs, breadcrumb, folder tree, note list, graph view)
- Backend graph: `src/vault_graph.py` (NetworkX graph builder), `src/vault_graph_cache.py`
- File watching: `src/vault_watcher.py`
- API routes: `routes/note_vault_routes.py`
- Graph rendering: `static/js/vaultGraphCanvas.js`, `static/js/pixiGraphRenderer.js`

## Dependency Patterns
- Vault UI (`vaultPanel.js`) → Vault routes (`note_vault_routes.py`) → `vault_graph.py` → `database.py`
- Document editor (`document.js`) → Notes API → `database.py`
- LLM core (`llm_core.py`) → Tool implementations → MCP servers

## When Modifying Code
**Before refactoring any of these, query the dependency graph:**
- `vaultPanel.js` touches tabs, breadcrumbs, note selection, folder tree, graph view, preview modes
- `vault_graph.py` affects graph rendering, community detection, bridge nodes
- `database.py` affects ALL persistence — high blast radius
- `llm_core.py` affects ALL AI features

## Regenerate
Run `py -3.12 run_graphify_code_only.py` to refresh after major changes.

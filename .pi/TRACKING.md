# Branch Tracking

Experimental branches that track non-upstream bases.

| Local Branch | Tracks | Relationship |
|---|---|---|
| `feat/plugin-system` | `zen0/feature/plugin-system` | Plugin contract from [Zen0-99/odysseus](https://github.com/Zen0-99/odysseus) (upstream PR #4241). Local branch is 2 commits ahead with core wiring for tool dispatch, schemas, settings routes, and chat context providers. |
| `feat/github-plugin` | `feat/plugin-system` | GitHub integration plugin — 14 agent tools, branch management UI, merge profiles. Built on top of the plugin system contract. |

## Remotes

| Remote | URL | Purpose |
|---|---|---|
| `origin` | `https://github.com/holden093/odysseus.git` | Your fork |
| `upstream` | `https://github.com/pewdiepie-archdaemon/odysseus.git` | Main project |
| `zen0` | `https://github.com/Zen0-99/odysseus.git` | Plugin system PR #4241 |

## Rules for Experimental Branches

- These branches are based on non-upstream bases and **never** merge into `local-dev`.
- Rebase onto their tracking base, not onto `dev`.
- When the tracking base lands in `upstream/dev`, migrate: rebase onto `dev`, then merge into `local-dev` like a normal feature branch.

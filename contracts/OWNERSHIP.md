# Directory Ownership — merge safety (arch §4, swarm rule 3)

NO AGENT EDITS OUTSIDE ITS OWN ROWS. `contracts/` is READ-ONLY for every agent after 0:15.

| Path | Owner agent |
|---|---|
| `contracts/**` | ORCHESTRATOR only (read-only to all agents) |
| `mock/**` | **A5-DATA** writes. A1a / A1b / A3 read only. |
| `api/**` | **A3** |
| `ingest/**` | **A2** |
| `web/` shell + map + lib (see `contracts/ui-contract.md`) | **A1a** |
| `web/src/panels/**`, `web/src/styles/panels.css` | **A1b** |
| `tests/e2e/**`, `playwright.config.ts`, `tests/package.json` | **QA-E2E** |
| `tests/contract/**` | **QA-CONTRACT** |
| `demo-runbook.md`, `README.md` | **A4** |
| `scripts/**` | **A3** (seed / run helpers) |
| `.env`, `web/.env.local` | ORCHESTRATOR only. Agents READ `.env`; they never write it. |

## If you need something outside your directory

DO NOT EDIT IT. Do not create a parallel copy of it either. Report it in your final message on its own line:

```
BLOCKED-ON: <path> — <exactly what you need and why>
```

The orchestrator resolves it. A file you silently created in someone else's directory will be deleted, and the time you spent on it is lost.

## Git

The orchestrator commits. Agents do not run `git commit`, `git add`, `git checkout`, or any branch operation.

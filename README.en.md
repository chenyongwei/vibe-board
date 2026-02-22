# Vibe Board (Multi-Device Task Dashboard)

## Project Background
In multi-device and multi-agent development workflows, task states are often scattered across local terminals and tools. Teams then struggle to quickly answer questions like:

- Which machine is currently working on what?
- Which tasks are done and waiting for verification?
- Is an agent offline, and for how long?

`vibe-board` centralizes these distributed states into one dashboard and provides practical run modes for both development and production.

## Feature Overview
### Core Capabilities
- Multi-machine task aggregation dashboard (grouped by machine/agent)
- Task status counters: `In Progress`, `Awaiting Verification`, `Verified`
- Task detail view with status filtering
- Cleans `<image></image>` markers from task titles
- Thumbnail previews for task images with click-to-zoom viewer
- Configurable machine display name in UI (overrides agent-reported name)
- Agent online/offline detection, with offline cards sorted later

### Alerting
- When a task on a card moves from `in_progress` to `awaiting_verification`:
  - Plays a sound alert
  - Triggers card flashing for 1 minute

### Agent Capabilities
- Simple JSON config via `agent.config.json`
  - Remote report endpoint
  - Machine name / machine identity
  - Adapter-related settings
- Cross-platform packaging for `Windows / macOS / Linux`
- GitHub Actions workflow for agent packaging and release

## Architecture
A unified external entry is exposed through `gateway` on port `61100`:

- `gateway` (Nginx)
  - `/api/*` forwards to `api`
  - `/` forwards to `ui`
- `api` (Node.js + Express)
  - Receives reports from agents
  - Aggregates task data and serves dashboard APIs
- `ui` (Nginx static site)
  - Hosts dashboard frontend
- `mysql`
  - Persists machine/task data
- `agent`
  - Collects local task state and reports to `api`

## Requirements
- Docker + Docker Compose v2
- Node.js + npm (for local agent development/packaging)

## Key Files
- `docker-compose.yml`: default production compose (`api/ui` built as images)
- `docker-compose.dev.yml`: development override (`api/ui` run with bind mounts)
- `start-dev.sh`: one-command development startup (docker dev + local agent dev)
- `start-prod.sh`: one-command production startup (docker build + agent release build)
- `reset-mysql.sh`: reset MySQL database
- `agent/agent.config.example.json`: agent config template (with parameter descriptions)

## Usage
### 1) Development Mode (Recommended for daily work)
Development mode behavior:

- `server api/ui` run with bind mounts, so code changes do not require Docker rebuilds
- `agent` runs locally via `npm run dev` with hot reload

Start:

```bash
./start-dev.sh
```

After startup:

- Dashboard: `http://localhost:61100/`
- API: `http://localhost:61100/api/*`
- Service logs: `.dev-server.log`
- Agent logs: `.dev-agent.log`

Notes:

- If `agent/agent.config.json` does not exist, it is automatically created from `agent/agent.config.example.json`.
- By default, pressing Ctrl+C stops Docker services as well.
- To exit the script but keep Docker services running:

```bash
KEEP_DOCKER_ON_EXIT=1 ./start-dev.sh
```

Manually stop the dev stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

### 2) Production Mode (Image-based deployment)
Production mode behavior:

- `api/ui` are built into Docker images
- Optional agent release build is executed

Start:

```bash
./start-prod.sh
```

After startup:

- Dashboard: `http://localhost:61100/`
- API: `http://localhost:61100/api/*`
- Service snapshot log: `.prod-server.log`
- Agent package output: `agent/release/`

By default, agent release build is enabled (`npm run package:agent`).
To skip it:

```bash
BUILD_AGENT_RELEASE=0 ./start-prod.sh
```

Stop the production stack:

```bash
docker compose -f docker-compose.yml down
```

## Database Reset
> Warning: This operation clears business data in the database.

Run:

```bash
./reset-mysql.sh
```

What it does:

- Waits until MySQL is ready
- Executes `DROP DATABASE` + `CREATE DATABASE`
- Restarts `api` so schema can be reinitialized

Override database name/password via env vars:

```bash
MYSQL_DATABASE=vibe_board MYSQL_ROOT_PASSWORD=vibe_root ./reset-mysql.sh
```

## Agent Configuration
Recommended setup from template:

```bash
cp agent/agent.config.example.json agent/agent.config.json
```

Common fields:

- `report_endpoint`: report target (default `http://127.0.0.1:61100/api/report`)
- `machine_id`: unique machine identifier
- `machine_name`: machine label shown on dashboard
- `report_interval_seconds`: reporting interval in seconds
- `env`: adapter-related settings (e.g. Codex/Claude/OpenCode paths and active windows)

Config priority:

`Environment Variables > Config File > Built-in Defaults`

## Quick Command Reference
```bash
# Development mode (docker dev + agent dev)
./start-dev.sh

# Production mode (docker build + optional agent release)
./start-prod.sh

# Reset database
./reset-mysql.sh

# Manually start dev docker stack only
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# Manually stop dev docker stack only
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

## API Summary
### Report Endpoint
- `POST /api/report`

Example request body:

```json
{
  "machine_id": "pc1",
  "machine_name": "PC-Dev-1",
  "machine_fingerprint": "stable-machine-fp-001",
  "tasks": [
    { "id": "t3", "title": "Run tests", "status": "in_progress" },
    { "id": "t2", "title": "Write API docs", "status": "completed_pending_verification" }
  ]
}
```

### Other Endpoints
- `GET /api/dashboard/history?machine_id=<id>&task_id=<task>&limit=<n>`
- `PUT /api/dashboard/machine/:id/display-name`

## Notes
- Tasks are deduplicated and persisted by `(machine_id, task.id)`.
- Machines are grouped by `machine_fingerprint + agent_name`:
  - Same machine with different agents: split into separate cards
  - Same agent with changed `machine_id`: still merged into one card
- Default offline rule: no report for more than `AGENT_OFFLINE_TIMEOUT_SECONDS` (default `45s`).

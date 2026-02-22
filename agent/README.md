Vibe Agent Starter (TypeScript/Node.js)

Overview
- Local agent to discover vibe tools on macOS/Linux, register adapters, and batch-report tasks to central API.
- MVP focuses on OpenCode, Codex, ClaudeCode adapters and a local registry.
- Supports periodic reporting and local retry queue when server is temporarily unavailable.

How to run
- Install Node.js, then:
  - cd agent
  - npm install
  - npm run build
  - npm run start
  - hot reload dev: npm run dev

Config file (recommended)
- Agent supports a simple JSON config file:
  - default lookup order:
    1) `--config /path/to/agent.config.json`
    2) `AGENT_CONFIG=/path/to/agent.config.json`
    3) `./agent.config.json` (current working directory)
    4) executable directory `agent.config.json` (for packaged binary)
- Copy template and edit:
  - `cp agent.config.example.json agent.config.json`
- Example:
```json
{
  "_help": {
    "usage": "将此文件复制为 agent.config.json 并按需修改",
    "priority": "优先级：环境变量 > 配置文件 > 内置默认值"
  },
  "report_endpoint": "http://127.0.0.1:61100/api/report",
  "report_interval_seconds": 15,
  "machine_id": "",
  "machine_name": "Mac Studio",
  "machine_fingerprint": "",
  "env": {
    "CODEX_HOME": "",
    "CODEX_SESSIONS_DIR": "",
    "CODEX_ARCHIVED_SESSIONS_DIR": "",
    "CODEX_ACTIVE_WINDOW_MINUTES": 30,
    "CODEX_MAX_SESSIONS": 50,
    "CLAUDE_CODE_CLI_PATH": "",
    "CLAUDE_CODE_SESSIONS_DIR": "",
    "CLAUDE_CODE_ACTIVE_WINDOW_MINUTES": 30,
    "CLAUDE_CODE_MAX_SESSIONS": 50,
    "OPENCODE_CLI_PATH": "",
    "OPENCODE_STORAGE_DIR": "",
    "OPENCODE_ACTIVE_WINDOW_MINUTES": 30,
    "OPENCODE_MAX_SESSIONS": 50
  }
}
```
- Env variables still work and have higher priority than config file values.

Cross-platform packaging (Windows / macOS / Linux)
- Build distributable binaries and launchers:
  - `cd agent`
  - `npm install`
  - `npm run package:agent`
- Output directory:
  - `agent/release/<platform-arch>/`
- Each package includes:
  - executable (`vibe-agent` or `vibe-agent.exe`)
  - editable `agent.config.json`（默认包含全部参数和参数说明）
  - one-click launcher:
    - Windows: `run-agent.bat`
    - macOS: `run-agent.command`
    - Linux: `run-agent.sh`

GitHub Actions
- Repository now includes workflow:
  - `.github/workflows/package-agent.yml`
- Trigger:
  - manual run (`workflow_dispatch`)
  - push tag (`agent-v*` or `v*`)
- Output:
  - uploaded build artifacts (`vibe-agent-*.zip`)
  - when triggered by tag, auto-create GitHub Release and attach packages.

Environment variables
- `REPORT_ENDPOINT`: API endpoint, default `http://localhost:61100/api/report`.
- `MACHINE_ID`: machine id sent to server, default hostname.
- `MACHINE_NAME`: display name sent to server, default `MACHINE_ID`.
- `MACHINE_FINGERPRINT`: stable machine identity key; if unset the agent auto-detects from OS and fallback storage.
- `REPORT_INTERVAL_SECONDS`: if `> 0`, run continuously at this interval. If unset or `<= 0`, run once and exit.
- `AGENT_CONFIG`: optional config file path (same schema as `agent.config.example.json`).
- `CODEX_HOME`: Codex home directory, default `~/.codex`.
- `CODEX_SESSIONS_DIR`: active Codex sessions directory, default `$CODEX_HOME/sessions`.
- `CODEX_ARCHIVED_SESSIONS_DIR`: archived Codex sessions directory, default `$CODEX_HOME/archived_sessions`.
- `CODEX_ACTIVE_WINDOW_MINUTES`: active session window (minutes), default `30`.
- `CODEX_MAX_SESSIONS`: max Codex sessions converted to tasks per cycle, default `50`.
- `CLAUDE_CODE_CLI_PATH`: Claude Code CLI path (optional), default `/usr/local/bin/claude-code`.
- `CLAUDE_CODE_SESSIONS_DIR`: Claude Code session jsonl root, default `~/.claude/projects`.
- `CLAUDE_CODE_ACTIVE_WINDOW_MINUTES`: Claude session active window (minutes), default `30`.
- `CLAUDE_CODE_MAX_SESSIONS`: max Claude sessions converted to tasks per cycle, default `50`.
- `OPENCODE_CLI_PATH`: OpenCode CLI path, default `~/.opencode/bin/opencode`.
- `OPENCODE_STORAGE_DIR`: OpenCode local storage root, default `~/.local/share/opencode/storage`.
- `OPENCODE_ACTIVE_WINDOW_MINUTES`: OpenCode session active window (minutes), default `30`.
- `OPENCODE_MAX_SESSIONS`: max OpenCode sessions converted to tasks per cycle, default `50`.

Retry queue
- Failed reports are persisted to `agent/data/report-queue.json`.
- On each cycle, the agent retries due queued reports before sending the latest snapshot.
- Backoff is exponential from 5s up to 5min.

Codex local vibe monitoring
- Codex adapter reads local session files (`.jsonl`) from `sessions` and `archived_sessions`.
- Status mapping:
  - Active sessions updated within window -> `in_progress`
  - Active but stale sessions -> `awaiting_verification`
  - Archived sessions -> `verified`

Claude Code local vibe monitoring
- Claude adapter reads local session files (`.jsonl`) from `~/.claude/projects` (or `CLAUDE_CODE_SESSIONS_DIR`).
- Status mapping:
  - Updated within active window -> `in_progress`
  - Stale sessions -> `awaiting_verification`

OpenCode local vibe monitoring
- OpenCode adapter reads sessions via `opencode session list --format json`, and falls back to local storage files under `~/.local/share/opencode/storage/session`.
- Status mapping:
  - Updated within active window -> `in_progress`
  - Stale sessions -> `awaiting_verification`

Notes
- This is a starter skeleton. You may expand with tests, Docker, and more adapters.

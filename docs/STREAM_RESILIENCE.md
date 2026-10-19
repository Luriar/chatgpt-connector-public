# Stream resilience and UI watchdog

ChatGPT Connector separates long-running work from the ChatGPT response stream.

## Persistent work

- High-level `work_start(kind=local)` tasks are stored in `.webjjonku` and now use `autoRecover=true` by default.
- If the connector process restarts while such a task is marked `running`, the current step is reset to `pending` and the task is re-queued.
- Low-level `task_create` keeps `auto_recover=false` by default because arbitrary shell commands may have side effects. Set it to true only when replay is safe.
- Ordinary NAS `exec_command` calls now start as durable tasks. If a command finishes within the foreground wait it returns normally; otherwise it returns a persistent `task_*` id while execution continues independently of the ChatGPT response stream.
- Durable command output is checkpointed while running and can be recovered later with `task_status` / `task_result`.
- Windows command requests are submitted through the coordinator. If `windows-worker` is offline, the task remains `waiting_for_device` with zero attempts and can be claimed after the PC returns.
- Goal/session/handoff state remains persistent, so a new Chat turn can resume from the last completed step.

This does not restart the ChatGPT model response itself. It keeps the underlying work independent of a UI/stream interruption.

## Connector supervisor

`scripts/supervise-chatgpt-connector.ps1` is the long-running outer supervisor. The per-user `ChatGPT-Connector` Scheduled Task runs this supervisor instead of a one-shot startup script.

It continuously checks:

- MCP health on `127.0.0.1:8747`;
- local Work coordinator health on `127.0.0.1:8780`;
- exactly one `cloud-browser-local` worker;
- the UI watchdog when it is enabled;
- Tailscale Funnel routing to the MCP root, with stale `/coordinator` exposure rejected.

If one of those checks fails, it invokes the idempotent startup script to repair the affected runtime. The Scheduled Task also has restart-on-failure settings, so the supervisor itself is restarted if it exits unexpectedly.

## ChatGPT desktop UI watchdog

Windows-only helper:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\chatgpt-ui-watchdog.ps1 -Action enable
```

Default mode: `retry`.

When the ChatGPT desktop UI exposes a recognized recovery/network error, including `stream recovery polling timed out`, `Resume stream unavailable`, or the supported network/polling-memory variants, the watchdog:

1. identifies the visible active ChatGPT composer;
2. requires a nearby semantic Retry/Try again/Regenerate/다시 시도/재시도 control so message text is not mistaken for an error banner;
3. invokes only that nearby retry control.

The watchdog does not auto-type `Continue...` into a conversation. This avoids acting on the wrong session. It is launched through a hidden `wscript.exe` wrapper so the watchdog itself does not steal foreground focus.

### Status

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\chatgpt-ui-watchdog.ps1 -Action status
```

### Disable

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\chatgpt-ui-watchdog.ps1 -Action disable
```

### One-shot test

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\chatgpt-ui-watchdog.ps1 -Action once
```

The watchdog is registered as the per-user Scheduled Task `ChatGPT-UI-Watchdog` while enabled, so it restarts after login. It is a Windows-only convenience layer; it is not required for NAS durable tasks.

## MCP controls

After the updated connector process is restarted/refreshed, these tools are exposed:

- `ui_watchdog_status`
- `ui_watchdog_enable`
- `ui_watchdog_disable`
- `ui_watchdog_test`

## Product boundary

The watchdog can recover a visible desktop UI error by UI Automation. It cannot operate a phone UI, recover a hidden remote client, or force OpenAI's backend to resume a specific interrupted model generation. Persistent Connector tasks are therefore the primary recovery mechanism; the UI watchdog is a best-effort convenience layer.

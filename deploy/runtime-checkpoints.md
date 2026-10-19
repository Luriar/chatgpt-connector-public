# Runtime profiles and task checkpoints

Explicit profiles use separate state under the first configured root:
`.webjjonku/runtimes/nas` and `.webjjonku/runtimes/windows`.
No profile retains legacy behavior. Existing state and active goals are not migrated.
On first profile start, an existing legacy HTTP secret is inherited into the
profile state so the registered MCP capability path stays stable. An explicitly configured secret still wins. Never copy active state while running.

Run these from the repository on the corresponding host:

```sh
node scripts/runtime.js start --profile nas
node scripts/runtime.js status --profile nas
node scripts/runtime.js start --profile windows
node scripts/runtime.js status --profile windows
```

NAS starts the existing Compose coordinator, connector and browser services.
Windows starts its independent MCP daemon (default port 8748; explicit config wins).
It does not attach Windows workers or change Funnel routes. Existing worker launchers
remain available separately. Windows status accepts `--config path`; NAS uses the
existing Compose mounts/config. `--dry-run` prints commands without starting services.
PowerShell entry point also accepts `-Profile nas|windows`; omitted profile is legacy.
Inside the NAS container, use `node /app/scripts/status.js --profile nas` for HTTP health;
the runtime NAS status command reports Compose service state.

Create tasks as short, restartable stages (recommended 30–60 seconds). Call
`task_checkpoint` with `id` and any of `summary`, `draft`, `command_results`,
`next_steps` before/after each stage and whenever a draft changes. Fields merge;
use empty strings/arrays to clear them. Store only concise decision summaries,
never private chain-of-thought. Unsaved model text cannot be recovered automatically.
Command output is persisted every five seconds and at step completion. Up to the
last five seconds of output can be lost on a process crash. Existing output caps apply.
This protects saved work; it does not remove the ChatGPT response timeout.

After interruption, use `task_status` to read the checkpoint and steps, then
`task_resume` after inspecting the incomplete command's side effects. Completed
steps are retained. Resume restarts the incomplete command, not its CPU state;
keep `auto_recover` false for commands that are unsafe to replay.

Minimal local verification (no service start, NAS access, or E2E):

```sh
node scripts/runtime-checkpoint-test.js
node --check src/config.js
node --check src/tools/tasks.js
node --check scripts/runtime.js
node --check scripts/status.js
git diff --check
```

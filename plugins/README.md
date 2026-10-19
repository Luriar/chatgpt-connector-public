# Optional plugin sources

| Component | Package definition | Server and UI source |
|---|---|---|
| Consumer Event Bridge | `consumer-event-bridge/` | `../apps/consumer-event-bridge/` |
| Web SDK Probe | `web-sdk-probe/` | `../apps/web-sdk-probe/` |
| Codex Relay Events | `codex-relay-events/` | `../apps/codex-relay-events/` |

These are source exports of the existing experiments. Existing installed plugin IDs, account bindings, hosting, credentials and visibility are unchanged.

The repository contains portable plugin manifests and MCP configuration examples. It does not contain live private endpoints, OAuth client IDs, tokens, subscription state or user email addresses. Configure and host your own servers first. Source publication does not install or activate a plugin.

Copy a plugin's `mcp.example.json` to ignored `mcp.local.json`, then replace all example URLs and OAuth placeholders with your own verified configuration. Run from the repository root:

```bash
npm ci
node scripts/package-optional-plugins.mjs consumer-event-bridge plugins/consumer-event-bridge/mcp.local.json
node scripts/package-optional-plugins.mjs web-sdk-probe plugins/web-sdk-probe/mcp.local.json
node scripts/package-optional-plugins.mjs codex-relay-events plugins/codex-relay-events/mcp.local.json
```

Run only the command for the package you configured. Each output ZIP contains one plugin at its root and is stored under ignored `dist/`. A configured ZIP may contain a private capability endpoint; keep it private.

The current account-bound Codex Relay Events app uses a separate account registration. Its personal app ID is not a portable dependency. The exported gateway and OAuth adapter implement the server side; consumers must register their own app/OAuth connection.

## Validation

Node.js 22 or later and the root `npm ci` are sufficient to run `npm run test:plugins`. Tests use temporary local data and mock or loopback transports. They do not contact the live NAS, call a model, install plugins, arm widgets or enable callbacks.

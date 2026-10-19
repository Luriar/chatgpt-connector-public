# Consumer Event Bridge integration

The v0.3.0 server, event store, UI, watchers, tests and optional deployment examples are included under `apps/consumer-event-bridge/` and `deploy/consumer-event-bridge/`.

## Run an isolated server

From the repository root, install dependencies with `npm ci`. Set `CONSUMER_EVENT_DATA` to an isolated private writable directory, optionally set `CONSUMER_EVENT_PORT`, and run:

```bash
npm --prefix apps/consumer-event-bridge test
npm --prefix apps/consumer-event-bridge start
```

The default bind address is loopback. The separate deployment compose file requires an explicit `EVENT_STATE_DIR` and does not replace the production Connector.

## Optional Connector adapter

`src/tools/consumer-event-bridge.js` is registered only when `WEBJJONKU_CONSUMER_EVENT_BRIDGE_URL` is configured. Leaving it unset preserves the existing default tool surface. Set it only to a trusted HTTPS bridge endpoint or loopback `/mcp` endpoint.

A local bridge implements `/mcp`. The `/v03/mcp` path in the portable plugin example is a reverse-proxy deployment path; configure your own route if you use it.

## Browser experiment source

The optional browser worker overlay is stored under `apps/consumer-event-bridge/browser-worker-overlay/` with helper modules and their tests under `scripts/`. It is not copied over the normal Connector browser worker.

The image builder uses the overlay only when explicitly invoked with a compatible base image. Browser triggering remains disabled by default in the on-demand compose override. No image build, live container replacement or browser navigation is performed by adding these files.

## Validation boundaries

The queue, session limits, explicit Start gate, receipt handling, duplicate prevention, local MCP integration and simulated UI behavior have automated tests. An accepted host message does not prove that a model ran or that a research result was saved. Closed-window automatic ChatGPT wakeup is not a supported capability.

See `../plugins/README.md` for all three optional plugin definitions and packaging.

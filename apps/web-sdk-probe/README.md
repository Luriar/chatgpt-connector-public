# Web SDK Probe

Recovered NAS file-event probe implementation v0.2.0, used by the installed Web SDK Probe plugin package v0.1.1. The server, UI, bounded event gate, fixed harmless producer and all three existing test files are included.

Run root `npm ci`, then `npm --prefix apps/web-sdk-probe test`. Start with `npm --prefix apps/web-sdk-probe start`; the MCP endpoint is loopback `http://127.0.0.1:18795/mcp`. Override `NAS_HOST_PROBE_PORT` to avoid a port conflict.

The `web_sdk_probe` tool opens a passive UI. An explicit Start click permits at most one fixed harmless event within a bounded session. A host receipt is not proof of model inference or completion. Closed-window wakeup is unsupported.

For a manual isolated test, start the server, open and arm the widget in the intended host, then run `npm --prefix apps/web-sdk-probe run produce -- --once`. The generated `nas-event.json` is ignored by Git. This publication does not run the producer.

Plugin definition and configurable MCP example: `../../plugins/web-sdk-probe/`. Hosting, TLS and the host connection must be configured separately. The automated tests validate the local protocol and simulated UI only.

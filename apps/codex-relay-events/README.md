# Codex Relay Events

Server source recovered from the existing Windows prototype, including the event gateway and OAuth resource adapter. Original source history is retained in the private repository. This directory is an optional component and does not alter the running Connector.

## Implemented source

- `relay-events-gateway.mjs`: local authenticated event discovery, scoped subscriptions, signed callback verification, idempotency and persistence.
- `oauth-resource-adapter.mjs`: OAuth metadata, JWT signature and issuer/audience/subject/scope validation, and a facade for the gateway.
- `auth0-public-config.example.json`: provider configuration shape with deployment values replaced by placeholders.

The connected app's read-only status path was previously observed. Live event subscription and automatic follow-up delivery remain unverified. Callback verification is disabled unless explicitly configured; model inference is not launched by these processes.

## Local verification

```bash
npm --prefix apps/codex-relay-events test
```

These self-tests use mock transport and local HTTP. They do not log in to an OAuth provider, contact the deployed server, send real callbacks or consume model/API inference.

## Configuration

Set `RELAY_OAUTH_ISSUER`, `RELAY_OAUTH_JWKS_URI`, `RELAY_OAUTH_RESOURCE`, and `RELAY_OAUTH_ALLOWED_SUB` to your verified provider settings. The gateway defaults to loopback port 18794; the OAuth adapter defaults to loopback port 18795. Set `RELAY_EVENTS_PORT` and `RELAY_OAUTH_PORT` when needed.

Run `npm --prefix apps/codex-relay-events run gateway` and `npm --prefix apps/codex-relay-events run oauth` in separate processes only after configuration. Generated `gateway-token.key` and `subscriptions.json` must stay private and are ignored.

Keep `RELAY_EVENTS_ALLOW_CALLBACK_VERIFICATION` disabled until you deliberately test callback verification in an isolated deployment. Public source publication does not enable it.

Portable definition: `../../plugins/codex-relay-events/`. The current account's app binding is not transferable; register your own connection rather than reusing a personal app ID.

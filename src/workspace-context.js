import { AsyncLocalStorage } from "node:async_hooks";

// Per-call defaults must never mutate the shared server configuration.
const calls = new AsyncLocalStorage();
export function withWorkspaceContext(workspace, callback) { return calls.run(workspace || null, callback); }
export function activeWorkspaceContext() { return calls.getStore() || null; }
export function workspaceDefaultRoot(cfg) { return activeWorkspaceContext()?.root || cfg.roots[0]; }

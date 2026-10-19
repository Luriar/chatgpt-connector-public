# ChatGPT Work Parity — Product Boundary

## Goal
Match the personal-use capabilities of ChatGPT Work as closely as possible from a normal Chat using webjjonku.

The target is functional parity, not replication of OpenAI-owned product UI or account infrastructure.

## Product-internal limits that webjjonku cannot literally reproduce

These are ChatGPT product surfaces or OpenAI-hosted account features. webjjonku can provide functional substitutes, but cannot make them the same internal feature.

1. ChatGPT account conversation storage and native web/mobile/desktop conversation sync.
2. OpenAI-operated Cloud Browser infrastructure and its first-party execution environment.
3. ChatGPT native Work UI, task cards, progress panes, notification center, and scheduling management screens.
4. ChatGPT Projects/Recents/sidebar integration and native conversation-to-project membership.
5. Plugin Directory discovery/install/recommendation UX and account-level plugin entitlement state.
6. First-party ChatGPT browser credential/password/autofill UI and OpenAI-managed browser profile state.
7. Native push notification delivery controlled by ChatGPT clients.
8. OpenAI account billing, quota, policy enforcement, internal telemetry, and abuse-prevention systems.
9. Any hidden internal Work orchestration behavior not exposed as a public contract.

## Implemented functional substitutes

1. Remote/cloud browser workers reachable through the coordinator.
2. Cross-device task/project/artifact/session state through coordinator sync.
3. Persistent scheduled tasks, webhooks, conditions, and notification event feeds.
4. Safe browser profile/CDP broker on the user's own machine plus remote browser workers.
5. Sites-like interactive artifact hosting/runtime with revisions and preview URLs.
6. Unified Work facade combining projects, tasks, artifacts, schedules, browser jobs, approvals, and plugins/skills.
7. Device reconnect/resume and waiting_for_device behavior.
8. External notification adapters where credentials are supplied.

## Definition of practical parity
If a personal user can ask a normal Chat to carry out the same class of work — files, browser, long-running jobs, schedules, remote execution, projects, artifacts, resumable tasks, connectors, approvals, and interactive site outputs — without manually invoking low-level MCP functions, the functional parity goal is met even though ChatGPT's own UI/account surfaces remain distinct.

# Device-specific skills and worker identity

Each Windows machine defaults to a unique `windows-<hostname>` worker ID. Use `WEBJJONKU_COORDINATOR_DEVICE_ID` or `--worker-id` to set an explicit ID.

The optional legacy `windows-worker` alias requires `WEBJJONKU_LEGACY_WORKER_HOSTNAME` to match the primary machine, or an explicit `WEBJJONKU_ALLOW_LEGACY_WORKER_ID=1` opt-in. Configure Connector routing to the chosen worker ID.

Check and bootstrap a new device with `scripts/device-skill-bootstrap.ps1`. Pass your own project root and expected hostname. Review the script's parameters before applying changes.

The public repository bundles only generic browser, coding, document, and Work skills. Keep personal skills, career evidence, credentials, and runtime state outside this repository.

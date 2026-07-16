# Telnyx Edge Compute — Examples

Runnable, prod-verified recipes for [Telnyx Edge Compute](https://developers.telnyx.com/docs/edge-compute/platform-overview).

Each folder is a self-contained function you can ship to the platform with the [Telnyx Edge CLI](https://github.com/team-telnyx/edge-compute).

## Examples

| Example | What it shows |
|---|---|
| [`call-telnyx-api`](./call-telnyx-api) | Use `env.MY_TELNYX` to send SMS — no API key handling |
| [`kv-read-write`](./kv-read-write) | Read, write, and TTL keys with `env.MY_KV` (Telnyx KV storage) |
| [`connection-reuse`](./connection-reuse) | Module-level state and warm-container reuse across requests |
| [`notes-rest-api`](./notes-rest-api) | Create / read / delete REST API backed by KV |
| [`voice-ivr`](./voice-ivr) | Inbound IVR menu with speech, gather, transfer, and voicemail |
| [`iot-data-ingestion`](./iot-data-ingestion) | IoT sensor readings → KV snapshot + Cloud Storage archive |

## Getting started

1. Install the CLI: see [team-telnyx/edge-compute](https://github.com/team-telnyx/edge-compute) releases.
2. Sign up at [portal.telnyx.com](https://portal.telnyx.com) and grab an API key.
3. Pick an example, follow its README.

## Feedback

Bugs, questions, or requests: open an issue.

## License

MIT

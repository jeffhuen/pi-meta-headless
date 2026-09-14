# pi-meta-headless

Standalone, zero-npm headless Meta (Muse Code) extension for [Pi](https://github.com/earendil-works/pi-coding-agent) with first-class **Muse Spark 1.3** support.

Connects directly to Meta's upstream Model API over HTTPS. **No background daemons, no launchd plists, no open TCP ports, and zero npm dependencies.**

---

## Highlights & Fidelity

- **Zero Daemons / Zero Open Ports**: Unlike `muse-bridge` which required background Python/Go daemon listeners on ports 8915/8916, `pi-meta-headless` runs directly in-process within Pi.
- **Live Streaming Reasoning**: Injects `summary: "auto"` and `include: ["reasoning.encrypted_content"]` so Meta streams live human-readable reasoning steps (`response.reasoning_summary_text.delta`) directly into Pi's thought display.
- **1M Token Context Window**: 1,007,997 token context window with up to 128,000 output tokens.
- **Strict Reasoning Sanitization**: Meta strictly rejects `effort: "none"` or `null` with HTTP 400; `pi-meta-headless` cleanly excises the reasoning block when disabled.
- **Prompt Cache Retention**: Enforces `prompt_cache_retention: "24h"` in top-level JSON for 24-hour KV caching across multi-turn sessions with full cache hit accounting.
- **Parameterless Tool Schema Defaulting**: Guarantees `parameters: { "type": "object" }` on input-less tools (like custom Pi tools or `cbmem`) to prevent Meta HTTP 400 schema validator rejections.
- **Multi-Turn Replay & Opaque Tool Results**: Fully preserves `rs_...` reasoning signatures and `fc_...` tool calls, keeping tool results opaque strings without destructive JSON mutation.
- **In-Memory Key Minting & Auto-Recovery**: Mints short-lived `LLM|...` keys from your Meta identity token with 20-hour caching, and transparently re-mints and retries once upon upstream HTTP 401.
- **Headless-Friendly Auth**: Supports Meta RFC 8628 Device Authorization flow for remote/SSH/terminal environments, and auto-discovers existing credentials from `~/.config/muse-bridge/identity.json` or `~/.config/muse/auth.json`.

---

## Models & Pricing

Pricing verified from the official [Meta Muse Code](https://developer.meta.com/ai/products/muse-code/) specifications:

| Model ID | Context Window | Max Output | Input / Mtok | Cached / Mtok | Output / Mtok |
|---|---|---|---|---|---|
| `meta/muse-spark-1.3` | **1,007,997** | 128,000 | $1.25 | $0.15 | $4.25 |
| `meta/muse-spark-1.3-contributor` | **1,007,997** | 128,000 | **$0.10** | **$0.002** | **$0.20** |
| `meta/muse-spark-1.2` | 1,007,997 | 128,000 | $1.25 | $0.15 | $4.25 |
| `meta/muse-spark-1.2-contributor` | 1,007,997 | 128,000 | $0.10 | $0.002 | $0.20 |

---

## Installation & Updates

### Install via Pi

```bash
pi install git:github.com/jeffhuen/pi-meta-headless
```

### Update to Latest Version

```bash
pi update git:github.com/jeffhuen/pi-meta-headless
```

### Uninstall / Remove

```bash
pi remove git:github.com/jeffhuen/pi-meta-headless
```

---

## Authentication

If you previously used `muse-bridge` or the official `muse` CLI, `pi-meta-headless` **automatically detects** your existing credentials from:
1. `~/.config/muse-bridge/identity.json`
2. `~/.config/muse/auth.json`
3. `MUSE_BRIDGE_IDENTITY` or `META_IDENTITY` environment variables

To log in from scratch on any machine or headless terminal:
```text
/meta.login
```
Pi will display a device authorization URL and user code:
```text
Open in your browser: https://auth.meta.com/oidc/device/authorization/...
Confirm code: ABCD-EFGH
```
Once approved, credentials are saved mode `0600` to `~/.config/muse-bridge/identity.json`.

---

## Usage in Pi

1. Start `pi`:
   ```bash
   pi
   ```
2. Switch to Muse Spark 1.3:
   ```text
   /model meta/muse-spark-1.3
   ```
   Or the lower-cost contributor tier:
   ```text
   /model meta/muse-spark-1.3-contributor
   ```
3. Check connection, token expiration, latency, and diagnostics:
   ```text
   /meta.doctor
   ```

### Thinking Levels & Effort

- **`muse-spark-1.3`**: Supports `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- **`muse-spark-1.3-contributor` & `1.2`**: Meta upstream supports up to `xhigh`. `pi-meta-headless` automatically maps `max` to `xhigh` for contributor models so your global Pi setting (`defaultThinkingLevel: "max"`) never triggers HTTP 400 parameter errors.

### Set as Default Provider

Add to `~/.pi/agent/settings.json`:

```json
{
  "defaultProvider": "meta",
  "defaultModel": "muse-spark-1.3",
  "defaultThinkingLevel": "high"
}
```

---

## Diagnostics

Verify your authentication status, active key, latency, and endpoint connectivity:
```text
/meta.doctor
```

---

## License

MIT © Jeff Huen

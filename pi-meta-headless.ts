/**
 * pi-meta-headless - Standalone, zero-npm Meta/Muse extension for Pi.
 *
 * Supports:
 * - Providers: `meta` (primary), `muse` (alias), `meta-bridge-go` (alias)
 * - Models: `muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-spark-1.2`, `muse-spark-1.2-contributor`
 * - Full 1M Context Window (1,007,997 tokens) & 128k Max Output Tokens
 *
 * Fidelity Features & Secret Sauce:
 * 1. Zero Daemons / Zero Open Ports: Direct HTTPS in-process streaming, no local proxy required.
 * 2. Zero-npm Dependency: Pure TypeScript using Node.js built-ins (crypto, fs, path, os, fetch).
 * 3. Live Streaming Reasoning Summaries: Injects `summary: "auto"` and `include: ["reasoning.encrypted_content"]`
 *    so Meta streams live human-readable reasoning deltas (`response.reasoning_summary_text.delta`).
 * 4. Strict Reasoning Sanitization: Completely drops `reasoning` when off/none to prevent Meta HTTP 400.
 * 5. Prompt Cache Retention: Explicit `prompt_cache_retention: "24h"` in top-level JSON for 24-hour KV caching.
 * 6. Parameterless Tool Defaulting: Enforces `parameters: { "type": "object" }` to prevent Meta HTTP 400 validator rejection.
 * 7. Multi-Turn Session & Tool Replay: Preserves `rs_...` reasoning signatures and `fc_...` function call items.
 * 8. Lossless Opaque Tool Results: Keeps tool output strings verbatim without destructive JSON re-parsing.
 * 9. In-Memory Key Minting & Auto-Recovery: Mints short-lived `LLM|...` keys, caches for 20h, and auto-refreshes
 *    transparently on HTTP 401 without failing turns.
 * 10. Headless-Friendly RFC 8628 Auth: Browserless terminal login via Meta Device Authorization + auto-discovery
 *     of `~/.config/muse-bridge/identity.json` and `~/.config/muse/auth.json`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --- Endpoints & Constants ---

export const PROVIDER_ID = "meta";
export const PROVIDER_NAME = "Meta (Muse Code)";
export const API_ID = "meta-responses";

export const UPSTREAM_BASE = "https://api.meta.ai";
export const RESPONSES_ENDPOINT = "https://api.meta.ai/v1/responses";
export const MINT_URL = "https://api.meta.ai/muse-code/key";

export const DEVICE_AUTH_URL = "https://auth.meta.com/oidc/device/authorization/";
export const DEVICE_TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
export const CLIENT_ID = "1031625952748946";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export const KEY_TTL_MS = 20 * 60 * 60 * 1000; // 20 hours

// --- Model Catalog & Pricing ---
// Pricing verified from official Meta developer documentation:
// https://developer.meta.com/ai/products/muse-code/

export const META_MODELS = [
  {
    id: "muse-spark-1.3",
    name: "Muse Spark 1.3",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1007997,
    maxTokens: 128000,
    cost: {
      input: 0.00000125,      // $1.25 / Mtok
      cacheRead: 0.00000015,  // $0.15 / Mtok
      output: 0.00000425,     // $4.25 / Mtok
    },
    thinkingLevelMap: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  },
  {
    id: "muse-spark-1.3-contributor",
    name: "Muse Spark 1.3 Contributor",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1007997,
    maxTokens: 128000,
    cost: {
      input: 0.00000010,      // $0.10 / Mtok (contributor tier)
      cacheRead: 0.000000002, // $0.002 / Mtok
      output: 0.00000020,     // $0.20 / Mtok
    },
    thinkingLevelMap: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  },
  {
    id: "muse-spark-1.2",
    name: "Muse Spark 1.2",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1007997,
    maxTokens: 128000,
    cost: {
      input: 0.00000125,
      cacheRead: 0.00000015,
      output: 0.00000425,
    },
    thinkingLevelMap: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  },
  {
    id: "muse-spark-1.2-contributor",
    name: "Muse Spark 1.2 Contributor",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1007997,
    maxTokens: 128000,
    cost: {
      input: 0.00000010,
      cacheRead: 0.000000002,
      output: 0.00000020,
    },
    thinkingLevelMap: {
      off: null,
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  },
];

// --- Paths & Credential Discovery ---

function getConfigBase(): string {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  return path.join(os.homedir(), ".config");
}

function getIdentityPath(): string {
  if (process.env.MUSE_BRIDGE_DIR) {
    return path.join(process.env.MUSE_BRIDGE_DIR, "identity.json");
  }
  return path.join(getConfigBase(), "muse-bridge", "identity.json");
}

function getMuseAuthPath(): string {
  return path.join(getConfigBase(), "muse", "auth.json");
}

export interface CredentialSource {
  identity?: string;
  directKey?: string;
  source: string;
}

export function loadCredentials(): CredentialSource | null {
  // 1. Explicit environment identity
  const envIdent = process.env.MUSE_BRIDGE_IDENTITY || process.env.META_IDENTITY;
  if (envIdent && envIdent.trim().length > 20) {
    return { identity: envIdent.trim(), source: "env:MUSE_BRIDGE_IDENTITY" };
  }

  // 2. ~/.config/muse-bridge/identity.json
  try {
    const idPath = getIdentityPath();
    if (fs.existsSync(idPath)) {
      const data = JSON.parse(fs.readFileSync(idPath, "utf8"));
      if (typeof data.identity === "string" && data.identity.length > 20) {
        return { identity: data.identity, source: "identity.json" };
      }
    }
  } catch {}

  // 3. ~/.config/muse/auth.json (Official Muse app token)
  try {
    const musePath = getMuseAuthPath();
    if (fs.existsSync(musePath)) {
      const data = JSON.parse(fs.readFileSync(musePath, "utf8"));
      const metaOauth = data?.providers?.meta;
      if (metaOauth?.mechanism === "oauth" && typeof metaOauth?.access_token === "string") {
        return { identity: metaOauth.access_token, source: "muse-auth.json:oauth" };
      }
    }
  } catch {}

  // 4. Static direct keys in environment
  for (const keyName of ["MUSE_BRIDGE_KEY", "META_API_KEY", "MODEL_API_KEY"]) {
    const val = process.env[keyName];
    if (val && val.trim().length > 20) {
      return { directKey: val.trim(), source: `env:${keyName}` };
    }
  }

  // 5. Scan ~/.config/muse/auth.json for static LLM keys
  try {
    const musePath = getMuseAuthPath();
    if (fs.existsSync(musePath)) {
      const data = JSON.parse(fs.readFileSync(musePath, "utf8"));
      let foundKey: string | null = null;
      const walk = (node: any) => {
        if (typeof node === "string") {
          if ((node.startsWith("LLM_") || node.startsWith("LLM|")) && !foundKey) {
            foundKey = node;
          }
        } else if (node && typeof node === "object") {
          for (const v of Object.values(node)) walk(v);
        }
      };
      walk(data);
      if (foundKey) {
        return { directKey: foundKey, source: "muse-auth.json:key" };
      }
    }
  } catch {}

  return null;
}

// --- Key Minting & In-Memory Cache ---

class KeyStore {
  private cachedKey: string | null = null;
  private cachedAt: number = 0;
  private pendingMint: Promise<string> | null = null;

  async getApiKey(): Promise<string> {
    const now = Date.now();
    if (this.cachedKey && now - this.cachedAt < KEY_TTL_MS) {
      return this.cachedKey;
    }

    if (this.pendingMint) {
      return this.pendingMint;
    }

    this.pendingMint = this.mintFreshKey();
    try {
      const key = await this.pendingMint;
      this.cachedKey = key;
      this.cachedAt = Date.now();
      return key;
    } finally {
      this.pendingMint = null;
    }
  }

  invalidate(failedKey: string): void {
    if (this.cachedKey === failedKey) {
      this.cachedKey = null;
      this.cachedAt = 0;
    }
  }

  private async mintFreshKey(): Promise<string> {
    const creds = loadCredentials();
    if (!creds) {
      throw new Error("No usable Meta credentials found. Run /meta.login or set MUSE_BRIDGE_IDENTITY.");
    }

    if (creds.directKey) {
      return creds.directKey;
    }

    if (!creds.identity) {
      throw new Error("Meta credential carries no usable identity.");
    }

    const res = await fetch(MINT_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${creds.identity}`,
        "Content-Type": "application/json",
        "x-api-version": "1.0.0",
      },
      body: "{}",
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Key mint failed (HTTP ${res.status}): ${errText.slice(0, 300)}`);
    }

    const body: any = await res.json();
    const key = body?.api_key;
    if (!key || typeof key !== "string" || key.length < 10) {
      throw new Error("Key mint succeeded but returned empty api_key");
    }

    return key;
  }
}

export const keyStore = new KeyStore();

// --- Headless Device Flow OAuth ---

export async function loginMetaHeadless(callbacks?: any): Promise<{ access: string; expires: number }> {
  // 1. Initiate Device Flow
  const initRes = await fetch(DEVICE_AUTH_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ client_id: CLIENT_ID }).toString(),
  });

  if (!initRes.ok) {
    throw new Error(`Device auth initiation failed (HTTP ${initRes.status}): ${await initRes.text()}`);
  }

  const authData: any = await initRes.json();
  const deviceCode = authData.device_code;
  const userCode = authData.user_code;
  const verificationUri = authData.verification_uri_complete || authData.verification_uri;
  let interval = (typeof authData.interval === "number" && authData.interval > 0) ? authData.interval : 5;
  const expiresIn = (typeof authData.expires_in === "number" && authData.expires_in > 0) ? authData.expires_in : 900;

  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error(`Invalid device auth response: ${JSON.stringify(authData)}`);
  }

  if (callbacks?.onDeviceCode) {
    callbacks.onDeviceCode({
      verificationUri,
      userCode,
      message: `Open ${verificationUri} and confirm code ${userCode}`,
    });
  } else {
    console.log(`\n========================================`);
    console.log(`Meta Authentication Required:`);
    console.log(`Open in your browser: ${verificationUri}`);
    console.log(`Confirm code: ${userCode}`);
    console.log(`========================================\n`);
  }

  // 2. Poll for approval
  const deadline = Date.now() + expiresIn * 1000;
  let identityToken: string | null = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const tokenRes = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: deviceCode,
        client_id: CLIENT_ID,
      }).toString(),
    });

    const tokenData: any = await tokenRes.json().catch(() => ({}));

    if (tokenRes.ok && tokenData.access_token) {
      identityToken = tokenData.access_token;
      break;
    }

    const error = tokenData.error;
    if (error === "authorization_pending" || !error) {
      continue;
    } else if (error === "slow_down") {
      interval += 5;
      continue;
    } else if (error === "access_denied") {
      throw new Error("Meta login was denied in the browser.");
    } else if (error === "expired_token") {
      throw new Error("Meta device code expired. Please run login again.");
    } else {
      throw new Error(`Meta login failed (HTTP ${tokenRes.status}): ${JSON.stringify(tokenData)}`);
    }
  }

  if (!identityToken) {
    throw new Error("Meta login timed out waiting for browser approval.");
  }

  // 3. Test key mint
  const mintRes = await fetch(MINT_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${identityToken}`,
      "Content-Type": "application/json",
      "x-api-version": "1.0.0",
    },
    body: "{}",
  });

  if (!mintRes.ok) {
    throw new Error(`Login approved, but key minting failed: ${await mintRes.text()}`);
  }

  // 4. Save to ~/.config/muse-bridge/identity.json
  const identityFilePath = getIdentityPath();
  const dir = path.dirname(identityFilePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    identityFilePath,
    JSON.stringify({ identity: identityToken, stored_at: Math.floor(Date.now() / 1000) }, null, 2),
    { mode: 0o600 }
  );

  return {
    access: identityToken,
    expires: Date.now() + 30 * 24 * 3600 * 1000,
  };
}

// --- AssistantMessage EventStream for Pi ---

class AssistantMessageEventStream {
  private queue: any[] = [];
  private waiting: ((val: { value: any; done: boolean }) => void)[] = [];
  private done = false;
  private finalResultPromise: Promise<any>;
  private resolveFinalResult!: (val: any) => void;

  constructor() {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: any) {
    if (this.done) return;
    if (event.type === "done" || event.type === "error") {
      this.done = true;
      this.resolveFinalResult(event.type === "done" ? event.message : event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(result?: any) {
    this.done = true;
    if (result !== undefined) {
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        const result: any = await new Promise((resolve) => this.waiting.push(resolve));
        if (result.done) return;
        yield result.value;
      }
    }
  }

  result(): Promise<any> {
    return this.finalResultPromise;
  }
}

// --- Message Conversion for /v1/responses ---

function convertContextMessages(context: any, model: any): any[] {
  const input: any[] = [];

  // 1. System Prompt -> Developer message
  if (context.systemPrompt && context.systemPrompt.trim()) {
    input.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: context.systemPrompt.trim() }],
    });
  }

  // 2. Transformed Messages
  const messages = context.messages || [];
  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        input.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: msg.content }],
        });
      } else if (Array.isArray(msg.content)) {
        const parts: any[] = [];
        for (const item of msg.content) {
          if (item.type === "text") {
            parts.push({ type: "input_text", text: item.text });
          } else if (item.type === "image") {
            parts.push({
              type: "input_image",
              detail: "auto",
              image_url: `data:${item.mimeType};base64,${item.data}`,
            });
          }
        }
        if (parts.length > 0) {
          input.push({ type: "message", role: "user", content: parts });
        }
      }
    } else if (msg.role === "assistant") {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "thinking") {
            if (block.thinkingSignature) {
              try {
                const item = JSON.parse(block.thinkingSignature);
                input.push(item);
              } catch {
                // Ignore corrupt signatures
              }
            }
          } else if (block.type === "text") {
            input.push({
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: block.text || "" }],
              status: "completed",
            });
          } else if (block.type === "toolCall") {
            const rawId = block.id || "";
            const [callId, itemIdRaw] = rawId.split("|");
            const itemId = itemIdRaw || `fc_${callId || idx}`;
            input.push({
              type: "function_call",
              id: itemId,
              call_id: callId || itemId,
              name: block.name,
              arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments || {}),
            });
          }
        }
      }
    } else if (msg.role === "toolResult") {
      const rawId = msg.toolCallId || "";
      const [callId] = rawId.split("|");
      let outputText = "";
      if (typeof msg.content === "string") {
        outputText = msg.content;
      } else if (Array.isArray(msg.content)) {
        outputText = msg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
      }
      input.push({
        type: "function_call_output",
        call_id: callId || rawId,
        output: outputText,
      });
    }
  }

  return input;
}

// --- Tools Conversion with Parameterless Defaulting ---

function convertContextTools(tools: any[] | undefined): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t: any) => {
    let params = t.parameters || t.inputSchema;
    // Meta validator requires parameters to be an object
    if (!params || typeof params !== "object" || Object.keys(params).length === 0) {
      params = { type: "object" };
    }
    return {
      type: "function",
      name: t.name,
      description: t.description || "",
      parameters: params,
    };
  });
}

// --- SSE Streaming Provider ---

function createStreamSimple() {
  return (model: any, context: any, options: any) => {
    const stream = new AssistantMessageEventStream();

    const output: any = {
      role: "assistant",
      content: [],
      api: API_ID,
      provider: PROVIDER_ID,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };

    (async () => {
      try {
        let apiKey = await keyStore.getApiKey();

        // Build parameters
        const inputMessages = convertContextMessages(context, model);
        const tools = convertContextTools(context.tools);

        // Normalize reasoning effort
        const effort = options?.reasoning;
        const hasReasoning = model.reasoning && effort !== "off" && effort !== "none" && effort !== null && effort !== undefined;

        const payload: any = {
          model: model.id,
          prompt_cache_retention: "24h",
          stream: true,
          store: false,
          input: inputMessages,
        };

        if (tools && tools.length > 0) {
          payload.tools = tools;
        }

        if (hasReasoning) {
          const effortLevel = model.thinkingLevelMap?.[effort] || effort || "high";
          payload.reasoning = {
            effort: effortLevel,
            summary: "auto", // Secret sauce: triggers Meta live streaming thought summaries!
          };
          payload.include = ["reasoning.encrypted_content"];
        }

        // Upstream round-trip with 401 transparent retry
        let resp: Response | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          resp = await fetch(RESPONSES_ENDPOINT, {
            method: "POST",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "x-api-version": "1.0.0",
            },
            body: JSON.stringify(payload),
            signal: options?.signal,
          });

          if (resp.status === 401 && attempt === 0) {
            keyStore.invalidate(apiKey);
            apiKey = await keyStore.getApiKey();
            continue;
          }
          break;
        }

        if (!resp || !resp.ok) {
          const errText = await resp?.text();
          output.stopReason = "error";
          output.errorMessage = `Meta API error (HTTP ${resp?.status || "unknown"}): ${errText?.slice(0, 400) || "none"}`;
          stream.push({ type: "error", reason: "error", error: output });
          stream.end();
          return;
        }

        stream.push({ type: "start", partial: output });

        const reader = resp.body?.getReader();
        if (!reader) throw new Error("No response body stream received from Meta");

        const decoder = new TextDecoder();
        let buffer = "";

        // Slots tracking
        const slots = new Map<number, { type: string; block: any; contentIndex: number }>();
        const reasoningBlocksById = new Map<string, any>();

        const getOrCreateSlot = (outputIndex: number, item: any) => {
          let slot = slots.get(outputIndex);
          if (slot) return slot;

          if (item.type === "reasoning") {
            const block = { type: "thinking", thinking: "" };
            output.content.push(block);
            slot = { type: "thinking", block, contentIndex: output.content.length - 1 };
            slots.set(outputIndex, slot);
            stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
            return slot;
          } else if (item.type === "message") {
            const block = { type: "text", text: "" };
            output.content.push(block);
            slot = { type: "text", block, contentIndex: output.content.length - 1 };
            slots.set(outputIndex, slot);
            stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
            return slot;
          } else if (item.type === "function_call") {
            const block = {
              type: "toolCall",
              id: `${item.call_id}|${item.id}`,
              name: item.name,
              arguments: {},
              partialJson: item.arguments || "",
            };
            output.content.push(block);
            slot = { type: "toolCall", block, contentIndex: output.content.length - 1 };
            slots.set(outputIndex, slot);
            stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
            return slot;
          }
          return null;
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === "[DONE]") continue;

            let event: any;
            try {
              event = JSON.parse(dataStr);
            } catch {
              continue;
            }

            const eventType = event.type;

            if (eventType === "response.created") {
              output.responseId = event.response?.id;
            } else if (eventType === "response.output_item.added") {
              getOrCreateSlot(event.output_index, event.item);
            } else if (eventType === "response.reasoning_summary_text.delta") {
              // Live streamed thinking summaries!
              const slot = slots.get(event.output_index);
              if (slot && slot.type === "thinking") {
                slot.block.thinking += event.delta;
                stream.push({
                  type: "thinking_delta",
                  contentIndex: slot.contentIndex,
                  delta: event.delta,
                  partial: output,
                });
              }
            } else if (eventType === "response.reasoning_summary_part.done") {
              const slot = slots.get(event.output_index);
              if (slot && slot.type === "thinking") {
                slot.block.thinking += "\n\n";
                stream.push({
                  type: "thinking_delta",
                  contentIndex: slot.contentIndex,
                  delta: "\n\n",
                  partial: output,
                });
              }
            } else if (eventType === "response.reasoning_text.delta") {
              const slot = slots.get(event.output_index);
              if (slot && slot.type === "thinking") {
                slot.block.thinking += event.delta;
                stream.push({
                  type: "thinking_delta",
                  contentIndex: slot.contentIndex,
                  delta: event.delta,
                  partial: output,
                });
              }
            } else if (eventType === "response.output_text.delta") {
              const slot = slots.get(event.output_index);
              if (slot && slot.type === "text") {
                slot.block.text += event.delta;
                stream.push({
                  type: "text_delta",
                  contentIndex: slot.contentIndex,
                  delta: event.delta,
                  partial: output,
                });
              }
            } else if (eventType === "response.function_call_arguments.delta") {
              const slot = slots.get(event.output_index);
              if (slot && slot.type === "toolCall") {
                slot.block.partialJson = (slot.block.partialJson || "") + event.delta;
                stream.push({
                  type: "toolcall_delta",
                  contentIndex: slot.contentIndex,
                  delta: event.delta,
                  partial: output,
                });
              }
            } else if (eventType === "response.function_call_arguments.done") {
              const slot = slots.get(event.output_index);
              if (slot && slot.type === "toolCall") {
                try {
                  slot.block.arguments = JSON.parse(event.arguments || slot.block.partialJson || "{}");
                } catch {
                  slot.block.arguments = {};
                }
              }
            } else if (eventType === "response.output_item.done") {
              const item = event.item;
              const slot = getOrCreateSlot(event.output_index, item);
              if (item.type === "reasoning" && slot?.type === "thinking") {
                const summaryText = item.summary?.map((s: any) => s.text).join("\n\n") || "";
                const contentText = item.content?.map((c: any) => c.text).join("\n\n") || "";
                slot.block.thinking = summaryText || contentText || slot.block.thinking;
                slot.block.thinkingSignature = JSON.stringify(item);
                reasoningBlocksById.set(item.id, slot.block);
                stream.push({
                  type: "thinking_end",
                  contentIndex: slot.contentIndex,
                  content: slot.block.thinking,
                  partial: output,
                });
                slots.delete(event.output_index);
              } else if (item.type === "message" && slot?.type === "text") {
                slot.block.text = item.content?.map((c: any) => (c.type === "output_text" ? c.text : "")).join("") || slot.block.text;
                slot.block.textSignature = JSON.stringify({ v: 1, id: item.id });
                stream.push({
                  type: "text_end",
                  contentIndex: slot.contentIndex,
                  content: slot.block.text,
                  partial: output,
                });
                slots.delete(event.output_index);
              } else if (item.type === "function_call" && slot?.type === "toolCall") {
                try {
                  slot.block.arguments = JSON.parse(item.arguments || slot.block.partialJson || "{}");
                } catch {
                  slot.block.arguments = {};
                }
                delete slot.block.partialJson;
                stream.push({
                  type: "toolcall_end",
                  contentIndex: slot.contentIndex,
                  toolCall: slot.block,
                  partial: output,
                });
                slots.delete(event.output_index);
              }
            } else if (eventType === "response.completed") {
              const respObj = event.response;
              if (respObj?.id) output.responseId = respObj.id;

              if (respObj?.usage) {
                const u = respObj.usage;
                const cached = u.input_tokens_details?.cached_tokens || 0;
                const cacheWrite = u.input_tokens_details?.cache_write_tokens || 0;
                const inTokens = Math.max(0, (u.input_tokens || 0) - cached - cacheWrite);
                const outTokens = u.output_tokens || 0;

                const modelCost = model.cost || { input: 0, cacheRead: 0, output: 0 };
                const costIn = inTokens * (modelCost.input || 0);
                const costCache = cached * (modelCost.cacheRead || 0);
                const costOut = outTokens * (modelCost.output || 0);

                output.usage = {
                  input: inTokens,
                  output: outTokens,
                  cacheRead: cached,
                  cacheWrite: cacheWrite,
                  reasoning: u.output_tokens_details?.reasoning_tokens || 0,
                  totalTokens: u.total_tokens || (inTokens + cached + outTokens),
                  cost: {
                    input: costIn,
                    output: costOut,
                    cacheRead: costCache,
                    cacheWrite: 0,
                    total: costIn + costCache + costOut,
                  },
                };
              }
            }
          }
        }

        if (output.content.some((b: any) => b.type === "toolCall")) {
          output.stopReason = "toolUse";
        } else if (output.stopReason === "pending") {
          output.stopReason = "stop";
        }

        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      } catch (err: any) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = err.message || "An unknown error occurred";
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    })();

    return stream;
  };
}

// --- Pi Extension Registration ---

export default function (pi: any): void {
  const streamSimple = createStreamSimple();

  const providerConfig = {
    name: PROVIDER_NAME,
    baseUrl: UPSTREAM_BASE,
    api: API_ID,
    models: META_MODELS,
    oauth: {
      name: PROVIDER_NAME,
      login: (callbacks: any) => loginMetaHeadless(callbacks),
      refreshToken: async (creds: any) => creds,
      getApiKey: async () => keyStore.getApiKey(),
    },
    streamSimple,
  };

  // Register primary provider: "meta"
  pi.registerProvider("meta", providerConfig);

  // Register alias: "muse"
  pi.registerProvider("muse", {
    ...providerConfig,
    name: "Meta Muse Code",
  });

  // Register alias: "meta-bridge-go" (for drop-in compatibility with existing models.json/settings.json)
  pi.registerProvider("meta-bridge-go", {
    ...providerConfig,
    name: "Meta Bridge (Native Headless)",
  });

  // Register diagnostic doctor command
  pi.registerCommand("meta.doctor", {
    description: "Check Meta / Muse authentication credentials and live API connectivity",
    handler: async (_args: any, ctx: any) => {
      const creds = loadCredentials();
      if (!creds) {
        const msg = "Authentication: No credentials found. Run /meta.login or set MUSE_BRIDGE_IDENTITY.";
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        else console.log(msg);
        return;
      }

      try {
        const t0 = Date.now();
        const key = await keyStore.getApiKey();
        const latency = Date.now() - t0;
        const msg = `Meta Auth: Connected (${creds.source})\nActive Key: ${key.slice(0, 10)}... (latency: ${latency}ms)\nDefault Model: meta/muse-spark-1.3\nEndpoint: ${RESPONSES_ENDPOINT}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else console.log(msg);
      } catch (err: any) {
        const msg = `Meta Auth Error: ${err.message}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else console.log(msg);
      }
    },
  });

  pi.registerCommand("meta.login", {
    description: "Authenticate with Meta via device flow",
    handler: async (_args: any, ctx: any) => {
      try {
        await loginMetaHeadless(ctx?.callbacks);
        const msg = "Meta login successful! You can now use meta/muse-spark-1.3.";
        if (ctx.hasUI) ctx.ui.notify(msg, "info");
        else console.log(msg);
      } catch (err: any) {
        const msg = `Meta login failed: ${err.message}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else console.log(msg);
      }
    },
  });
}

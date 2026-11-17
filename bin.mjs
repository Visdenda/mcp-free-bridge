#!/usr/bin/env node
/**
 * Stdio bridge for the anonymous Visdenda free MCP server.
 *
 * MCP clients that only speak stdio spawn this file, write newline-delimited
 * JSON-RPC to stdin, and read newline-delimited JSON-RPC from stdout. Every
 * message is POSTed to the remote Streamable HTTP endpoint; JSON and
 * text/event-stream responses are both accepted. This is a transport shim,
 * not a second MCP implementation.
 */

import { createInterface } from "node:readline";

const DEFAULT_ENDPOINT = "https://visdenda.com/v1/mcp/free";
const DEFAULT_TIMEOUT_MS = 60_000;
const configuredEndpoint = process.env.VISDENDA_MCP_URL?.trim();
const ENDPOINT = configuredEndpoint || DEFAULT_ENDPOINT;
const REQUEST_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const MAX_ERROR_MESSAGE_LENGTH = 500;

const timeoutFromEnv = () => {
  const raw = Number(process.env.VISDENDA_MCP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_MS;
};
const TIMEOUT_MS = timeoutFromEnv();

const diagnostic = (message) => {
  process.stderr.write(`[visdenda-mcp-free] ${message}\n`);
};

const errorMessageOf = (error) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";

const truncate = (text) =>
  text.length > MAX_ERROR_MESSAGE_LENGTH ? `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...` : text;

const writeMessage = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const writeError = (id, message) => {
  writeMessage({ jsonrpc: "2.0", id, error: { code: -32000, message: truncate(message) } });
};

/** Pull the last parseable `data:` payload out of an SSE body. */
const parseSseBody = (body) => {
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");

  for (let index = dataLines.length - 1; index >= 0; index -= 1) {
    try {
      return { found: true, value: JSON.parse(dataLines[index]) };
    } catch {
      // Not JSON; keep looking at earlier events.
    }
  }
  return { found: false, value: undefined };
};

const parseResponseBody = (body, contentType) => {
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return parseSseBody(body);
  }
  try {
    return { found: true, value: JSON.parse(body) };
  } catch {
    // Some proxies omit the SSE content type; retry as an event stream.
    return parseSseBody(body);
  }
};

const describeHttpFailure = (response, body) => {
  let detail = "";
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.error?.message === "string") {
      detail = `: ${parsed.error.message}`;
    }
  } catch {
    // HTML or empty error bodies add no useful detail.
  }
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  return `HTTP ${response.status}${statusText} from ${ENDPOINT}${detail}`;
};

/**
 * The endpoint answers failures with a complete JSON-RPC error object
 * (`-32003` plus `data.code`/`retryAfterSeconds`). Passing it through keeps the
 * client's error handling and the model's retry decision intact; synthesising a
 * `-32000` would drop the quota details.
 */
const jsonRpcErrorOf = (value, id) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (value.jsonrpc !== "2.0" || value.id !== id) return null;
  if (typeof value.error !== "object" || value.error === null) return null;
  return value;
};

const sendRequest = async (message, id) => {
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: REQUEST_HEADERS,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.text();
    const contentType = response.headers.get("content-type") ?? "";

    if (!response.ok) {
      const parsedFailure = parseResponseBody(body, contentType);
      const passthrough = parsedFailure.found ? jsonRpcErrorOf(parsedFailure.value, id) : null;
      if (passthrough) {
        writeMessage(passthrough);
      } else {
        writeError(id, describeHttpFailure(response, body));
      }
      return;
    }

    const parsed = parseResponseBody(body, contentType);
    if (!parsed.found) {
      writeError(id, `Unparseable response from ${ENDPOINT}`);
      return;
    }
    writeMessage(parsed.value);
  } catch (error) {
    writeError(id, `Request to ${ENDPOINT} failed: ${errorMessageOf(error)}`);
  }
};

const sendNotification = async (message) => {
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: REQUEST_HEADERS,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.text();
    if (!response.ok) {
      diagnostic(`notification rejected with HTTP ${response.status}`);
    }
  } catch (error) {
    diagnostic(`notification failed: ${errorMessageOf(error)}`);
  }
};

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const handleLine = async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
    return;
  }

  if (hasOwn(message, "id") && message.id !== undefined) {
    await sendRequest(message, message.id);
    return;
  }
  await sendNotification(message);
};

let pending = Promise.resolve();
const enqueue = (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  pending = pending
    .then(() => handleLine(trimmed))
    .catch((error) => diagnostic(`internal error: ${errorMessageOf(error)}`));
};

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", enqueue);
input.on("close", () => {
  pending.finally(() => {
    if (process.exitCode === undefined) process.exitCode = 0;
  });
});

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") {
    process.exit(0);
  }
  diagnostic(`stdout error: ${errorMessageOf(error)}`);
});

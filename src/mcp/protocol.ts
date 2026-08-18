/**
 * Minimal Model Context Protocol implementation.
 *
 * MCP is JSON-RPC 2.0 over newline-delimited stdio with a handful of methods,
 * which is small enough to implement directly. Doing so keeps the promise that
 * Faultix ships no runtime dependencies — an extension that pulls a package
 * tree into someone's editor to expose four read-only queries is a bad trade.
 *
 * Pure: framing and dispatch only. Everything that touches the filesystem
 * lives behind the `ToolRegistry` the caller supplies.
 */

/** Protocol revisions this server understands, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05'] as const;

export const JSONRPC_VERSION = '2.0';

/** Standard JSON-RPC error codes, plus the ones MCP leans on. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603
} as const;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface JsonRpcRequest {
  jsonrpc: string;
  /** Absent on notifications, which take no response. */
  id?: string | number | null;
  method: string;
  params?: Record<string, JsonValue>;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id: string | number | null;
  result?: JsonValue;
  error?: { code: number; message: string; data?: JsonValue };
}

/** One tool the server exposes. */
export interface ToolDefinition {
  name: string;
  /** Shown to the model; this is what decides whether the tool gets called. */
  description: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, JsonValue>;
    required?: string[];
  };
}

export interface ToolResult {
  /** Rendered text the model reads. */
  text: string;
  /** True when the tool failed in a way the model should know about. */
  isError?: boolean;
}

export interface ToolRegistry {
  list(): ToolDefinition[];
  call(name: string, args: Record<string, JsonValue>): Promise<ToolResult>;
}

export interface ServerInfo {
  name: string;
  version: string;
}

/** Parses one line of input. Returns undefined for blank lines. */
export function parseMessage(line: string): JsonRpcRequest | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  return JSON.parse(trimmed) as JsonRpcRequest;
}

function isRequest(message: JsonRpcRequest): boolean {
  // A notification has no id; per JSON-RPC it must not be answered.
  return message.id !== undefined && message.id !== null;
}

export function errorResponse(
  id: string | number | null,
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } };
}

export function resultResponse(id: string | number | null, result: JsonValue): JsonRpcResponse {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

/**
 * Negotiates a protocol version.
 *
 * Echoing back a version the client asked for is only correct when it is one
 * this server actually implements; otherwise the newest supported version is
 * offered and the client decides whether it can proceed.
 */
export function negotiateVersion(requested: unknown): string {
  const supported: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;
  if (typeof requested === 'string' && supported.includes(requested)) {
    return requested;
  }
  return SUPPORTED_PROTOCOL_VERSIONS[0];
}

/**
 * Handles one message. Returns the response to write, or undefined when the
 * message was a notification.
 */
export async function handleMessage(
  message: JsonRpcRequest,
  tools: ToolRegistry,
  info: ServerInfo
): Promise<JsonRpcResponse | undefined> {
  const id = message.id ?? null;

  if (message.jsonrpc !== JSONRPC_VERSION) {
    return isRequest(message)
      ? errorResponse(id, ErrorCode.InvalidRequest, `Expected jsonrpc "${JSONRPC_VERSION}"`)
      : undefined;
  }

  switch (message.method) {
    case 'initialize': {
      if (!isRequest(message)) {
        return undefined;
      }
      return resultResponse(id, {
        protocolVersion: negotiateVersion(message.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, version: info.version }
      });
    }

    // Sent by the client once it is ready; there is nothing to reply to.
    case 'notifications/initialized':
    case 'initialized':
      return undefined;

    case 'ping':
      return isRequest(message) ? resultResponse(id, {}) : undefined;

    case 'tools/list': {
      if (!isRequest(message)) {
        return undefined;
      }
      return resultResponse(id, { tools: tools.list() as unknown as JsonValue });
    }

    case 'tools/call': {
      if (!isRequest(message)) {
        return undefined;
      }

      const name = message.params?.name;
      if (typeof name !== 'string') {
        return errorResponse(id, ErrorCode.InvalidParams, 'tools/call requires a string "name"');
      }

      const rawArgs = message.params?.arguments;
      const args =
        rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, JsonValue>)
          : {};

      try {
        const result = await tools.call(name, args);
        return resultResponse(id, {
          content: [{ type: 'text', text: result.text }],
          isError: result.isError ?? false
        });
      } catch (error) {
        // A tool that throws is reported as a tool-level error rather than a
        // protocol error: the model can read it and try something else, which
        // it cannot do with a transport failure.
        return resultResponse(id, {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true
        });
      }
    }

    default:
      return isRequest(message)
        ? errorResponse(id, ErrorCode.MethodNotFound, `Unknown method: ${message.method}`)
        : undefined;
  }
}

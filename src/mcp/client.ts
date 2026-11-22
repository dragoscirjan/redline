import { Effect, type Scope } from 'effect';

/** Server configuration and native SDK session/tool payloads await their compatibility specification. */
export type McpServerConfiguration = unknown;
export type McpSession = unknown;
export type McpToolCatalog = unknown;
export type McpToolCall = unknown;
export type McpToolResult = unknown;

export class McpClient {
  connect(configuration: McpServerConfiguration): Effect.Effect<McpSession, Error, Scope.Scope> {
    // Acquire one configured connection and close owned transport/process resources with its scope.
    return Effect.fail(new Error('Not implemented: McpClient.connect'));
  }

  listTools(session: McpSession): Effect.Effect<McpToolCatalog, Error> {
    // Observe discovery separately from actual tool calls and successful results.
    return Effect.fail(new Error('Not implemented: McpClient.listTools'));
  }

  callTool(session: McpSession, call: McpToolCall): Effect.Effect<McpToolResult, Error> {
    // Use the selected client SDK with bounded output and cancellation, forwarding only explicit server credentials.
    return Effect.fail(new Error('Not implemented: McpClient.callTool'));
  }
}

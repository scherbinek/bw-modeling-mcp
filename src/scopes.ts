/**
 * Scope enforcement for the HTTP transport.
 *
 * One scope, `analyst`, granted by the role collection "BW MCP Analyst". It admits the tools
 * listed below — finding BW queries released as OData services, reading their definition and
 * reading their results. Nothing this server offers writes or runs anything in BW.
 *
 * The list is explicit and anything not on it is refused: a tool added later without touching
 * this file is unavailable rather than silently offered.
 *
 * This gates who may call the server. What a caller can actually see in BW is decided by BW,
 * against the ABAP user behind the request — under principal propagation that is the caller
 * themselves (S_SERVICE for the Gateway service, analysis authorizations for the data).
 * Scopes restrict; they never widen.
 *
 * stdio has no authInfo and therefore no scopes: whoever runs the process already holds
 * the credentials.
 */
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

export type Scope = 'analyst';

export const SCOPES: readonly Scope[] = ['analyst'];

const ANALYST_TOOLS = new Set(['bw_find_queries', 'bw_describe_query', 'bw_read_query']);

/** Accepts bare or XSUAA-qualified scopes (`bwmcp!t123.analyst`). */
function has(scopes: readonly string[], scope: Scope): boolean {
  return scopes.some((s) => s === scope || s.endsWith(`.${scope}`));
}

export function hasScope(authInfo: AuthInfo | undefined, scope: Scope): boolean {
  if (!authInfo) return true; // stdio
  return has(authInfo.scopes ?? [], scope);
}

/** May this caller invoke this tool? */
export function mayCall(toolName: string, authInfo: AuthInfo | undefined): boolean {
  if (!authInfo) return true; // stdio
  return ANALYST_TOOLS.has(toolName) && hasScope(authInfo, 'analyst');
}

/** Hide tools the caller cannot invoke, so a model never proposes a call that will be denied. */
export function filterToolsByScope<T extends { name: string }>(
  tools: T[],
  authInfo: AuthInfo | undefined,
): T[] {
  if (!authInfo) return tools;
  return tools.filter((t) => mayCall(t.name, authInfo));
}

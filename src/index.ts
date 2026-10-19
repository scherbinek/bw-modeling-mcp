#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';

import { createClientFromEnv } from './bw-client.js';
import { filterToolsByScope, mayCall } from './scopes.js';
import { undeclaredArguments } from './arguments.js';
import { bwDescribeQuery, bwFindQueries, bwReadQuery } from './tools/queries.js';

// ── Tool definitions ──────────────────────────────────────────────────────────

const SERVICE_PARAM = {
  type: 'string',
  description:
    'The query: its technical name (e.g. "ZSALES_Q001"), its OData service name ("ZSALES_Q001_SRV") ' +
    'or the service path/URL bw_find_queries lists.',
};

export const TOOL_DEFINITIONS = [
  {
    name: 'bw_find_queries',
    description:
      'Find BW queries released as OData services, from the SAP Gateway service catalog. ' +
      'Matches the search term against service name, title and description (case-insensitive). ' +
      'Start here when the query name is not known.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description: 'Part of the query name or description, e.g. "SALES". Omit to list every service.',
        },
        top: { type: 'number', description: 'Maximum number of services listed. Default 50, at most 500.' },
        verify: {
          type: 'boolean',
          description:
            'Keep only services that really are BW queries, by reading the metadata of each match ' +
            '(one request per match). Default false.',
        },
      },
    },
  },
  {
    name: 'bw_describe_query',
    description:
      'Read the definition of a BW query from its OData metadata: its variables (with whether they are ' +
      'mandatory), its characteristics and its key figures, each with technical name and label. ' +
      'The technical names are what bw_read_query takes in "variables", "select", "filter" and "orderby".',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { service: SERVICE_PARAM },
      required: ['service'],
    },
  },
  {
    name: 'bw_read_query',
    description:
      'Read the result of a BW query through its OData service. BW aggregates the key figures over every ' +
      'characteristic not in "select", so select exactly the characteristics the answer is broken down by, ' +
      'plus the key figures. Says whether more rows follow. Call bw_describe_query first for the names.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        service: SERVICE_PARAM,
        variables: {
          type: 'object',
          description:
            'Variable values by technical name, e.g. {"P_CALYEAR": "2025"}. Mandatory variables must be given; ' +
            'optional ones left out are sent empty. Dates as YYYY-MM-DD.',
          additionalProperties: { type: ['string', 'number'] },
        },
        select: {
          type: 'array',
          items: { type: 'string' },
          description: 'Characteristics and key figures to return (technical names). Omit for every column.',
        },
        filter: {
          type: 'string',
          description: "OData $filter expression, e.g. \"A0COUNTRY eq 'DE' and A0CALMONTH ge '202501'\".",
        },
        orderby: { type: 'string', description: 'OData $orderby expression, e.g. "A0CALMONTH desc".' },
        top: { type: 'number', description: `Maximum number of rows. Default 100, at most 5000.` },
        skip: { type: 'number', description: 'Rows to skip, for reading on after a previous call.' },
      },
      required: ['service'],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleToolCall(
  request: { params: { name: string; arguments?: Record<string, unknown> } },
  extra: { authInfo?: AuthInfo },
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { name, arguments: args = {} } = request.params;

  // Deny before doing any work. stdio has no authInfo and nothing to check.
  if (!mayCall(name, extra.authInfo)) {
    throw new McpError(ErrorCode.InvalidRequest, `Tool '${name}' requires the 'analyst' scope.`);
  }

  const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!tool) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);

  // A misspelt parameter would otherwise be passed over and the answer would look complete.
  const refused = undeclaredArguments(tool, args);
  if (refused) return { content: [{ type: 'text', text: refused }], isError: true };

  try {
    // HTTP: the per-request client, whose identity came from XSUAA and the destination.
    // stdio: no request context, so the environment is read.
    const client = createClientFromEnv();
    let text: string;
    switch (name) {
      case 'bw_find_queries':
        text = await bwFindQueries(client, args as Parameters<typeof bwFindQueries>[1]);
        break;
      case 'bw_describe_query':
        text = await bwDescribeQuery(client, args as Parameters<typeof bwDescribeQuery>[1]);
        break;
      case 'bw_read_query':
        text = await bwReadQuery(client, args as Parameters<typeof bwReadQuery>[1]);
        break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text }] };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }
}

// ── Server ────────────────────────────────────────────────────────────────────

const { version: VERSION } = createRequire(import.meta.url)('../package.json') as { version: string };

/**
 * Sent in the MCP initialize response. Clients that defer tool loading use it to decide
 * whether this server's tools are worth fetching at all, so the domain is named up front.
 * BW_MCP_SYSTEM_LABEL tells several instances (dev/QA/prod) apart in clients that show an
 * opaque connector id instead of the advertised server name.
 */
function buildInstructions(): string {
  const label = process.env.BW_MCP_SYSTEM_LABEL;
  return [
    ...(label ? [`Connected SAP BW system: ${label}.`, ''] : []),
    'Read-only access to SAP BW queries released as OData services: find a query, read its',
    'variables, characteristics and key figures, and read its result. Reach for it for any',
    'question answered by the reporting data of this BW system. Nothing can be changed or run.',
    '',
    'One BW system per instance: there is no system selector, by design.',
  ].join('\n');
}

/**
 * Build an MCP server with every tool registered.
 *
 * A factory rather than a module-level instance: the SDK binds a Server to exactly one
 * transport for its lifetime, so the stateless HTTP transport needs a fresh one per
 * request. stdio calls this once.
 */
export function createServer(): Server {
  const server = new Server(
    { name: process.env.BW_MCP_SERVER_NAME || 'bw-modeling-mcp', version: VERSION },
    { capabilities: { tools: {} }, instructions: buildInstructions() },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => ({
    tools: filterToolsByScope(TOOL_DEFINITIONS, extra.authInfo),
  }));
  server.setRequestHandler(CallToolRequestSchema, handleToolCall);
  return server;
}

// ── Start (stdio) ─────────────────────────────────────────────────────────────

export async function startStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
  // Log to stderr only (stdout is used for MCP protocol messages)
  process.stderr.write('bw-modeling-mcp server started\n');
}

// Local MCP client configs may still launch `node dist/index.js`; start stdio when this file
// is the process entry point. When imported (stdio.ts / http.ts) this is a no-op.
function isRunAsMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isRunAsMain()) {
  startStdio().catch((err) => {
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
  });
}

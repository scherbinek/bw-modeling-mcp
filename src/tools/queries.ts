import type { BwClient } from '../bw-client.js';
import { loadQueryService, resultPath, type QueryService } from '../query-service.js';

const CATALOG = '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection';
const JSON_ACCEPT = 'application/json';
const MAX_ROWS = 5000;

// ── bw_find_queries ─────────────────────────────────────────────────────────

interface CatalogEntry {
  TechnicalServiceName?: string;
  TechnicalServiceVersion?: string;
  Title?: string;
  Description?: string;
  ServiceUrl?: string;
}

/**
 * Search the Gateway service catalog for query services.
 *
 * The catalog lists every registered service and does not say which of them were generated
 * for a BW query. `verify` answers that by reading each match's $metadata, which costs one
 * request per match — off by default, and the search term keeps the number small.
 */
export async function bwFindQueries(
  client: BwClient,
  args: { search?: string; top?: number; verify?: boolean },
): Promise<string> {
  const { body } = await client.get(`${CATALOG}?$format=json`, JSON_ACCEPT);
  const entries: CatalogEntry[] = JSON.parse(body)?.d?.results ?? [];

  const term = args.search?.trim().toLowerCase();
  let matches = entries.filter((e) =>
    !term ||
    [e.TechnicalServiceName, e.Title, e.Description, e.ServiceUrl].some((f) => f?.toLowerCase().includes(term)),
  );
  const total = matches.length;
  const top = Math.max(1, Math.min(args.top ?? 50, 500));
  matches = matches.slice(0, top);

  const lines: string[] = [];
  if (args.verify) {
    const checked = await mapLimited(matches, 5, async (e) => {
      try {
        await loadQueryService(client, servicePathOf(e));
        return e;
      } catch {
        return undefined;
      }
    });
    matches = checked.filter((e): e is CatalogEntry => e !== undefined);
  }

  lines.push(
    `${total} service(s) in the Gateway catalog match${term ? ` "${args.search}"` : ''}` +
      (total > top ? `, the first ${top} shown` : '') +
      (args.verify ? `; ${matches.length} of them are BW queries` : '') +
      '.',
  );
  for (const e of matches) {
    const title = e.Title || e.Description || '';
    lines.push(`- ${e.TechnicalServiceName}${title ? ` — ${title}` : ''}  (${servicePathOf(e)})`);
  }
  if (matches.length > 0) {
    lines.push('', 'BW query services are named <QUERY>_SRV. bw_describe_query shows a service\'s variables, characteristics and key figures.');
  }
  return lines.join('\n');
}

function servicePathOf(e: CatalogEntry): string {
  const url = e.ServiceUrl ?? '';
  const at = url.toLowerCase().indexOf('/sap/opu/odata/');
  return at >= 0 ? url.slice(at).replace(/\/+$/, '') : `/sap/opu/odata/sap/${e.TechnicalServiceName}`;
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── bw_describe_query ───────────────────────────────────────────────────────

export async function bwDescribeQuery(client: BwClient, args: { service: string }): Promise<string> {
  const q = await loadQueryService(client, args.service);
  return describe(q);
}

function describe(q: QueryService): string {
  const lines = [`Query service ${q.path}`, ''];

  lines.push(`Variables (${q.variables.length}):`);
  if (q.variables.length === 0) lines.push('  none — the result is read without input');
  for (const v of q.variables) {
    lines.push(`  ${v.name}  ${v.label}  [${v.type}${v.mandatory ? ', mandatory' : ', optional'}]`);
  }

  lines.push('', `Characteristics (${q.characteristics.length}) — select them to break the key figures down:`);
  for (const c of q.characteristics) {
    lines.push(`  ${c.name}  ${c.label}${c.text ? `  (text: ${c.text})` : ''}`);
  }

  lines.push('', `Key figures (${q.keyFigures.length}):`);
  for (const k of q.keyFigures) {
    lines.push(`  ${k.name}  ${k.label}${k.unit ? `  (unit/currency: ${k.unit})` : ''}`);
  }

  lines.push(
    '',
    'Read with bw_read_query. BW aggregates over every characteristic left out of "select", ' +
      'so select only the characteristics the answer is broken down by.',
  );
  return lines.join('\n');
}

// ── bw_read_query ───────────────────────────────────────────────────────────

/** Technical columns of every query result, meaningless to a reader. */
const HIDDEN = new Set(['__metadata', 'ID', 'TotaledProperties']);

export async function bwReadQuery(
  client: BwClient,
  args: {
    service: string;
    variables?: Record<string, unknown>;
    select?: string[];
    filter?: string;
    orderby?: string;
    top?: number;
    skip?: number;
  },
): Promise<string> {
  const q = await loadQueryService(client, args.service);
  const top = Math.max(1, Math.min(args.top ?? 100, MAX_ROWS));
  const skip = Math.max(0, args.skip ?? 0);

  // One row more than asked, to say whether more follow without a second count request.
  const params = [`$format=json`, `$top=${top + 1}`];
  if (skip > 0) params.push(`$skip=${skip}`);
  if (args.select?.length) params.push(`$select=${encodeURIComponent(args.select.join(','))}`);
  if (args.filter) params.push(`$filter=${encodeURIComponent(args.filter)}`);
  if (args.orderby) params.push(`$orderby=${encodeURIComponent(args.orderby)}`);

  const { body } = await client.get(`${resultPath(q, args.variables)}?${params.join('&')}`, JSON_ACCEPT);
  const results: Record<string, unknown>[] = JSON.parse(body)?.d?.results ?? [];
  const more = results.length > top;
  const rows = results.slice(0, top).map(cleanRow);

  const header =
    `${rows.length} row(s) from ${q.path}` +
    (skip > 0 ? `, starting after row ${skip}` : '') +
    (more ? `. More rows follow — read on with skip=${skip + top}.` : '. No more rows follow.');
  return `${header}\n\n${JSON.stringify(rows, null, 1)}`;
}

function cleanRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (HIDDEN.has(k)) continue;
    out[k] = typeof v === 'string' ? odataDate(v) : v;
  }
  return out;
}

/** OData V2 JSON dates (`/Date(1704067200000)/`) as ISO dates; everything else unchanged. */
function odataDate(v: string): string {
  const m = v.match(/^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/);
  if (!m) return v;
  const iso = new Date(Number(m[1])).toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
}

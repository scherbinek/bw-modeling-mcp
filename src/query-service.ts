/**
 * A BW query released as an OData service, and what its $metadata says about it.
 *
 * BW generates one Gateway service per query that has the "By OData" property set and is
 * registered in /IWFND/MAINT_SERVICE, named `<QUERY>_SRV`. Its model is always the same shape:
 *
 *   - an entity type with `sap:semantics="aggregate"` — the result. Characteristics are the
 *     properties with `sap:aggregation-role="dimension"`, key figures those with "measure".
 *     Around them sit generated companions: `<char>_T` texts, `<kf>_E` units or currencies,
 *     `<kf>_F` formatted values, plus the technical `ID` key and `TotaledProperties`.
 *   - when the query has input-ready variables, an entity type with
 *     `sap:semantics="parameters"`, whose key properties are the variables. The result is
 *     then only reachable through it: `<Params>(VAR='x')/Results`.
 *
 * A service without an aggregate entity type is not a BW query, and is refused.
 */
import { XMLParser } from 'fast-xml-parser';
import type { BwClient } from './bw-client.js';

const ODATA_ROOT = '/sap/opu/odata/';

export interface QueryProperty {
  name: string;
  label: string;
  type: string;
  /** Text companion of a characteristic, unit/currency and formatted value of a key figure. */
  text?: string;
  unit?: string;
}

export interface QueryVariable {
  name: string;
  label: string;
  type: string;
  mandatory: boolean;
}

export interface QueryService {
  /** Service root below the system URL, e.g. `/sap/opu/odata/sap/ZSALES_Q001_SRV`. */
  path: string;
  /** Entity set that holds the result, or the parameter set when there are variables. */
  resultSet: string;
  parameterSet?: { name: string; navigation: string };
  variables: QueryVariable[];
  characteristics: QueryProperty[];
  keyFigures: QueryProperty[];
}

/**
 * The service root for what a caller passed: a query name (`ZSALES_Q001`), a service name
 * (`ZSALES_Q001_SRV`), a service path or a full service URL as the Gateway catalog lists it.
 *
 * Anything that would leave the OData root — another path, `..`, a query string — is refused:
 * the result is appended to the BW system URL and must not reach other services there.
 */
export function servicePath(service: string): string {
  const input = (service ?? '').trim();
  if (!input) throw new Error('"service" is required: a query name, its OData service name or service URL.');

  let path: string;
  const rootAt = input.toLowerCase().indexOf(ODATA_ROOT);
  if (rootAt >= 0) {
    path = input.slice(rootAt).replace(/\/+$/, '');
  } else {
    const name = input.toUpperCase();
    if (!/^[A-Z0-9_/]+$/.test(name)) {
      throw new Error(`"${service}" is not a valid query or service name.`);
    }
    path = `${ODATA_ROOT}sap/${name.endsWith('_SRV') ? name : `${name}_SRV`}`;
  }
  if (/\.\.|[?#\\\s]/.test(path) || !/^\/sap\/opu\/odata\/[A-Za-z0-9_/;=.]+$/.test(path)) {
    throw new Error(`"${service}" does not name an OData service below ${ODATA_ROOT}.`);
  }
  return path;
}

const ARRAY_TAGS = new Set(['Schema', 'EntityType', 'Property', 'PropertyRef', 'NavigationProperty', 'EntitySet']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // `sap:label` becomes `label`, `edmx:Edmx` becomes `Edmx`. No attribute in a query
  // service's model is ambiguous without its namespace.
  removeNSPrefix: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

/** Read and interpret the $metadata of a query service. */
export async function loadQueryService(client: BwClient, service: string): Promise<QueryService> {
  const path = servicePath(service);
  const { body } = await client.get(`${path}/$metadata`, 'application/xml');
  return parseQueryMetadata(path, body);
}

export function parseQueryMetadata(path: string, xml: string): QueryService {
  const doc = parser.parse(xml);
  const schemas: any[] = doc?.Edmx?.DataServices?.Schema ?? [];
  const types: any[] = schemas.flatMap((s) => s.EntityType ?? []);
  const sets: any[] = schemas.flatMap((s) => s.EntityContainer?.EntitySet ?? []);
  const setOf = (type: any): string | undefined =>
    sets.find((s) => String(s.EntityType).split('.').pop() === type.Name)?.Name;

  const resultType = types.find((t) => t.semantics === 'aggregate');
  if (!resultType) {
    throw new Error(
      `${path} is not a BW query service: its model has no aggregate entity type. ` +
        'Only queries released "By OData" can be read.',
    );
  }
  const resultSet = setOf(resultType);
  if (!resultSet) throw new Error(`${path}: no entity set exposes the query result ${resultType.Name}.`);

  const properties: any[] = resultType.Property ?? [];
  const toProperty = (p: any): QueryProperty => ({
    name: p.Name,
    label: p.label ?? p.Name,
    type: p.Type,
    ...(p.text ? { text: p.text } : {}),
    ...(p.unit ? { unit: p.unit } : {}),
  });

  const service: QueryService = {
    path,
    resultSet,
    variables: [],
    characteristics: properties.filter((p) => p['aggregation-role'] === 'dimension').map(toProperty),
    keyFigures: properties.filter((p) => p['aggregation-role'] === 'measure').map(toProperty),
  };

  const paramType = types.find((t) => t.semantics === 'parameters');
  if (paramType) {
    const keys = new Set((paramType.Key?.PropertyRef ?? []).map((r: any) => r.Name));
    const nav = (paramType.NavigationProperty ?? [])[0]?.Name;
    const paramSet = setOf(paramType);
    if (paramSet && nav) {
      service.parameterSet = { name: paramSet, navigation: nav };
      service.variables = (paramType.Property ?? [])
        .filter((p: any) => keys.has(p.Name))
        .map((p: any) => ({
          name: p.Name,
          label: p.label ?? p.Name,
          type: p.Type,
          mandatory: p.parameter === 'mandatory',
        }));
    }
  }
  return service;
}

/** An OData V2 key literal for a variable value. */
function keyLiteral(type: string, value: string): string {
  switch (type) {
    case 'Edm.String':
      return `'${encodeURIComponent(value.replace(/'/g, "''"))}'`;
    case 'Edm.DateTime': {
      const v = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
      return `datetime'${encodeURIComponent(v)}'`;
    }
    case 'Edm.Decimal':
      return `${encodeURIComponent(value)}M`;
    default:
      return encodeURIComponent(value);
  }
}

/**
 * The path of the entity set that returns rows, with every variable in the key predicate.
 *
 * OData needs the full key, so an optional variable left out is sent empty. A mandatory one
 * left out, or a value for something that is not a variable, is refused before calling BW.
 */
export function resultPath(service: QueryService, values: Record<string, unknown> = {}): string {
  const known = new Set(service.variables.map((v) => v.name));
  const unknown = Object.keys(values).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `Not a variable of this query: ${unknown.join(', ')}. ` +
        (known.size > 0 ? `Its variables are: ${[...known].join(', ')}.` : 'It has no input-ready variables.'),
    );
  }
  if (!service.parameterSet) return `${service.path}/${service.resultSet}`;

  const missing = service.variables.filter((v) => v.mandatory && (values[v.name] ?? '') === '');
  if (missing.length > 0) {
    throw new Error(`Mandatory variables without a value: ${missing.map((v) => `${v.name} (${v.label})`).join(', ')}.`);
  }
  const keys = service.variables.map((v) => `${v.name}=${keyLiteral(v.type, String(values[v.name] ?? ''))}`);
  return `${service.path}/${service.parameterSet.name}(${keys.join(',')})/${service.parameterSet.navigation}`;
}

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import https from 'https';
import * as fs from 'fs';
import { currentClient } from './request-context.js';

/**
 * A read-only HTTP client for the SAP Gateway in front of BW.
 *
 * Every request is a GET, so there is no CSRF token, no lock and no stateful session to
 * protect: the credential travels with each request, and the cookies the server sets are
 * kept only so a logon is not repeated within one MCP call.
 */

export interface GetResult {
  body: string;
  headers: Record<string, string>;
}

/** Cloud Connector hop. The token expires, so it is resolved per request. */
export interface BwProxyConfig {
  host: string;
  port: number;
  /** Connectivity-service token, sent as `Proxy-Authorization: Bearer …`. */
  token: string;
  /** `SAP-Connectivity-SCC-Location_ID`, when several Cloud Connectors serve the subaccount. */
  locationId?: string;
}

/**
 * How a client authenticates to BW.
 *
 * `pp` is BTP principal propagation: the Destination service returns a value that the
 * Cloud Connector converts into a short-lived X.509 certificate for the calling user.
 * It is deliberately a separate variant rather than an extra optional field, so a
 * per-user client cannot also carry a shared credential.
 */
export type BwAuth =
  | { kind: 'basic'; user: string; password: string }
  | { kind: 'cookies'; cookies: Record<string, string> }
  | { kind: 'pp'; connectivityAuth: string };

export interface BwClientOptions {
  url: string;
  auth: BwAuth;
  client?: string;
  language?: string;
  proxy?: BwProxyConfig;
}

/**
 * Turn a failed response into an error message a model can act on.
 *
 * Gateway answers OData errors as JSON or XML with the message nested inside; that message
 * is what is worth showing. The ICF answers a request for a service that does not exist with
 * a full "Logon Error Message" HTML page, which is replaced by the sentence it actually means.
 */
export function bwHttpError(label: string, status: number, data: unknown): Error {
  const body = typeof data === 'string' ? data : data === undefined ? '' : JSON.stringify(data);

  const odataMessage =
    tryJson(body)?.error?.message?.value ?? body.match(/<message[^>]*>([^<]*)<\/message>/)?.[1];
  if (odataMessage) return new Error(`${label} → HTTP ${status}\n${odataMessage}`);

  const isHtml = /^\s*(?:<!DOCTYPE\s+html|<html\b)/i.test(body) || /<title>\s*Logon Error/i.test(body);
  if (!isHtml) return new Error(`${label} → HTTP ${status}\n${body}`);

  const path = label.match(/\/sap\/\S+/)?.[0]?.split('?')[0];
  if (status === 404) {
    return new Error(
      `${label} → HTTP ${status}\nThe service ${path ?? 'behind this path'} is not active or ` +
        'not registered on this system (/IWFND/MAINT_SERVICE).',
    );
  }
  // The ICF titles its page "Logon Error Message" whatever went wrong, so the title is
  // quoted as the server's wording rather than presented as the cause.
  const title = body.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
  if (status >= 500 && title && !/Logon Error/i.test(title)) {
    return new Error(
      `${label} → HTTP ${status}\nBW failed while processing the request — a runtime error on the ` +
        `server, not a missing service; transaction ST22 shows the short dump. The page is titled "${title}".`,
    );
  }
  return new Error(
    `${label} → HTTP ${status}\nThe server returned an HTML page instead of an API response — ` +
      'the service is not reachable for this user (ICF service inactive, or the logon was ' +
      `rejected).${title ? ` The page is titled "${title}".` : ''}`,
  );
}

function tryJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// Connection-level failures that mean "the socket died", not "the server said no". The
// request never reached the backend, and every request here is a GET, so retrying is safe.
function isTransportError(err: any): boolean {
  const code = err?.code ?? err?.cause?.code;
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNABORTED' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    /socket hang up/i.test(String(err?.message ?? ''))
  );
}

export class BwClient {
  private readonly http: AxiosInstance;
  private readonly cookies = new Map<string, string>();
  private readonly frozenCookies = new Set<string>();
  private readonly opts: BwClientOptions;

  constructor(opts: BwClientOptions) {
    this.opts = opts;

    // In cookie mode (e.g. BW Bridge) sap-client is not sent: the browser logon the
    // cookies come from already fixed the client.
    const isCookieMode = opts.auth.kind === 'cookies';
    this.http = axios.create({
      baseURL: opts.url,
      // Cloud Connector: standard absolute-URI proxying. The destination URL must be
      // http:// — an https:// target makes axios tunnel with CONNECT, which drops the
      // Proxy-Authorization and SAP-Connectivity-Authentication headers, and the
      // connectivity proxy answers 405.
      // `undefined`, never `false`: false would also disable the HTTP_PROXY/http_proxy
      // environment variables, and some hosts are reachable only through that proxy.
      proxy: opts.proxy ? { host: opts.proxy.host, port: opts.proxy.port, protocol: 'http' } : undefined,
      headers: {
        ...(!isCookieMode && opts.client ? { 'sap-client': opts.client } : {}),
        ...(opts.language ? { 'sap-language': opts.language } : {}),
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(data) => data],
    });

    if (opts.auth.kind === 'cookies') {
      for (const [name, value] of Object.entries(opts.auth.cookies)) {
        this.cookies.set(name, value);
        // Names from the cookie file are frozen — set-cookie responses must not overwrite them.
        this.frozenCookies.add(name);
      }
    }
  }

  /**
   * The identity credential, sent on every request.
   *
   * `Authorization` is never sent under principal propagation — SAP reserves it for basic
   * auth to the backend, and sending it breaks identity propagation.
   */
  private authHeaders(): Record<string, string> {
    const auth = this.opts.auth;
    if (auth.kind === 'basic') {
      return { Authorization: 'Basic ' + Buffer.from(`${auth.user}:${auth.password}`).toString('base64') };
    }
    if (auth.kind === 'pp') return { 'SAP-Connectivity-Authentication': auth.connectivityAuth };
    return {};
  }

  /** Proxy credentials belong on every request — the connectivity proxy authorizes each hop. */
  private proxyHeaders(): Record<string, string> {
    const proxy = this.opts.proxy;
    if (!proxy) return {};
    return {
      'Proxy-Authorization': `Bearer ${proxy.token}`,
      ...(proxy.locationId ? { 'SAP-Connectivity-SCC-Location_ID': proxy.locationId } : {}),
    };
  }

  private cookieHeaders(): Record<string, string> {
    if (this.cookies.size === 0) return {};
    return { Cookie: [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') };
  }

  private updateCookies(response: AxiosResponse): void {
    const setCookies = response.headers['set-cookie'];
    if (!setCookies) return;
    for (const c of setCookies) {
      const part = c.split(';')[0];
      const eqIdx = part.indexOf('=');
      if (eqIdx <= 0) continue;
      const name = part.substring(0, eqIdx).trim();
      if (this.frozenCookies.has(name)) continue;
      this.cookies.set(name, part.substring(eqIdx + 1).trim());
    }
  }

  /** GET a path below the system URL. Throws on any status of 400 and above. */
  async get(path: string, accept: string): Promise<GetResult> {
    const send = () =>
      this.http.get(path, {
        headers: { ...this.authHeaders(), ...this.proxyHeaders(), ...this.cookieHeaders(), Accept: accept },
      });
    let response;
    try {
      response = await send();
    } catch (err) {
      if (!isTransportError(err)) throw err;
      response = await send();
    }
    this.updateCookies(response);
    if (response.status >= 400) throw bwHttpError(`GET ${path}`, response.status, response.data);
    return { body: response.data as string, headers: response.headers as Record<string, string> };
  }
}

/**
 * The client for the current call.
 *
 * Under HTTP the request context holds a client carrying the caller's identity (see
 * request-context.ts). Under stdio there is no request context and the environment is read.
 */
export function createClientFromEnv(): BwClient {
  return currentClient() ?? clientFromEnvironment();
}

function clientFromEnvironment(): BwClient {
  const url = process.env.BW_URL;
  const client = process.env.BW_CLIENT ?? '001';
  const language = process.env.BW_LANGUAGE;
  const cookieFile = process.env.BW_COOKIE_FILE;

  if (!url) {
    throw new Error('Required environment variable missing: BW_URL');
  }

  // Cookie mode: BW Bridge or other SAML/OAuth-fronted BW systems where Basic Auth is not
  // available. Cookies are exported from an authenticated browser session. File format:
  // Netscape (7 tab-separated fields) or simple "name=value" lines; # starts a comment.
  if (cookieFile) {
    let raw: string;
    try {
      raw = fs.readFileSync(cookieFile, 'utf-8');
    } catch (err) {
      throw new Error(`Failed to read BW_COOKIE_FILE at ${cookieFile}: ${(err as Error).message}`);
    }
    const cookies: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split('\t');
      if (parts.length >= 7) {
        cookies[parts[5]] = parts[6];
      } else {
        const eq = trimmed.indexOf('=');
        if (eq > 0) cookies[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
    }
    if (Object.keys(cookies).length === 0) {
      throw new Error(
        `BW_COOKIE_FILE at ${cookieFile} contains no parseable cookies (expected Netscape or name=value format).`,
      );
    }
    return new BwClient({ url, client, language, auth: { kind: 'cookies', cookies } });
  }

  const user = process.env.BW_USER;
  const password = process.env.BW_PASSWORD;
  if (!user || !password) {
    throw new Error('Required environment variables missing: BW_URL, BW_USER, BW_PASSWORD');
  }
  return new BwClient({ url, client, language, auth: { kind: 'basic', user, password } });
}

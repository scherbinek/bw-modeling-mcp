/**
 * Build a BW client from a BTP destination.
 *
 * Two destination styles are supported, chosen by the destination itself:
 *
 *   Authentication=PrincipalPropagation — per-user. The caller's JWT is exchanged at
 *     the Destination service for a value the Cloud Connector turns into a short-lived
 *     X.509 certificate, so BW sees the actual person and applies their own
 *     authorizations.
 *
 *   Authentication=BasicAuthentication — shared. The destination carries one technical
 *     user; every caller reaches BW as that user. Simpler to set up, but BW cannot tell
 *     callers apart, so the MCP scopes are the only per-user control.
 *
 * Both may run through the Cloud Connector (ProxyType=OnPremise) or connect directly.
 */
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { BTPConfig, BTPProxyConfig, Destination } from '@arc-mcp/xsuaa-auth/btp';
import { BwClient, type BwProxyConfig } from './bw-client.js';

export interface DestinationDeps {
  btpConfig: BTPConfig;
  proxy?: BTPProxyConfig;
  destinationName: string;
}

/**
 * Through the Cloud Connector the destination URL must be http://.
 *
 * SAP: "the call from the cloud application must always use HTTP. If HTTPS is used, a
 * 405 response will be returned." Independently, an https:// target makes the HTTP
 * client tunnel with CONNECT, which silently drops both the proxy and identity headers
 * — so the 405 arrives with nothing pointing at the real cause. The Cloud Connector
 * still uses HTTPS to reach BW.
 */
export function assertProxyableUrl(url: string, destinationName: string): void {
  if (!url.startsWith('http://')) {
    throw new Error(
      `Destination '${destinationName}' has URL '${url}', but Cloud Connector routing requires http://. ` +
        'An https:// destination makes the HTTP client tunnel via CONNECT, which drops the ' +
        'principal-propagation headers and returns 405. Use the http:// virtual host here — ' +
        'the Cloud Connector still reaches BW over HTTPS.',
    );
  }
}

async function resolveProxy(
  destination: Destination,
  deps: DestinationDeps,
): Promise<BwProxyConfig | undefined> {
  // Only on-premise destinations tunnel through the Cloud Connector. Routing an
  // internet destination through it would be wrong, not merely slower.
  if (destination.ProxyType !== 'OnPremise' || !deps.proxy) return undefined;
  assertProxyableUrl(destination.URL, deps.destinationName);
  return {
    host: deps.proxy.host,
    port: deps.proxy.port,
    token: await deps.proxy.getProxyToken(),
    // The destination's own location id wins: with several Cloud Connectors on one
    // subaccount, reusing the startup one routes to the wrong connector.
    locationId: destination.CloudConnectorLocationId ?? deps.proxy.locationId,
  };
}

function baseOptions(destination: Destination) {
  return {
    url: destination.URL,
    // `sap-client` is not a documented destination property, but destinations commonly
    // carry it and it is the natural place for it. Environment wins if both are set.
    client: process.env.BW_CLIENT ?? destination['sap-client'],
    language: process.env.BW_LANGUAGE ?? (destination.originalProperties?.['sap-language'] as string | undefined),
  };
}

/** Per-user client via principal propagation. Fails closed — never returns a shared identity. */
export async function createPrincipalPropagationClient(
  deps: DestinationDeps,
  authInfo: AuthInfo | undefined,
): Promise<BwClient> {
  const token = authInfo?.token;
  if (!token || token.split('.').length !== 3) {
    throw new Error(
      'Principal propagation requires a JWT bearer token; the request carried none (or an opaque token).',
    );
  }

  const { lookupDestinationWithUserToken } = await import('@arc-mcp/xsuaa-auth/btp');
  const { destination, authTokens } = await lookupDestinationWithUserToken(
    deps.btpConfig,
    deps.destinationName,
    token,
  );

  // The lookup populates sapConnectivityAuth; it never sets ppProxyAuth, which is
  // reserved for consumers implementing the newer jwt-bearer exchange themselves.
  const connectivityAuth = authTokens.sapConnectivityAuth;
  if (!connectivityAuth) {
    throw new Error(
      `Principal propagation failed for destination '${deps.destinationName}': the Destination service ` +
        'returned no SAP-Connectivity-Authentication header. Check that the destination has ' +
        'Authentication=PrincipalPropagation, that the Cloud Connector is connected, and that the ' +
        'issuing identity provider is trusted and synchronized in the Cloud Connector.',
    );
  }

  return new BwClient({
    ...baseOptions(destination),
    auth: { kind: 'pp', connectivityAuth },
    proxy: await resolveProxy(destination, deps),
  });
}

/** Shared client from a BasicAuthentication destination. Every caller reaches BW as one user. */
export async function createSharedDestinationClient(deps: DestinationDeps): Promise<BwClient> {
  const { lookupDestination } = await import('@arc-mcp/xsuaa-auth/btp');
  const destination = await lookupDestination(deps.btpConfig, deps.destinationName);
  if (!destination.User || !destination.Password) {
    throw new Error(
      `Destination '${deps.destinationName}' has Authentication=${destination.Authentication} but carries no ` +
        'user and password. Use BasicAuthentication with credentials, or PrincipalPropagation for per-user access.',
    );
  }
  return new BwClient({
    ...baseOptions(destination),
    auth: { kind: 'basic', user: destination.User, password: destination.Password },
    proxy: await resolveProxy(destination, deps),
  });
}

/** Human-readable caller, for logs. The JWT was already verified by the bearer middleware. */
export function userLabel(authInfo: AuthInfo | undefined): string {
  const token = authInfo?.token;
  if (!token) return 'anonymous';
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.user_name ?? payload.email ?? payload.sub ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

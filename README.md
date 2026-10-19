# bw-modeling-mcp — BW MCP Analyst

A Model Context Protocol (MCP) server that lets AI assistants like Claude **find and read SAP BW
queries** through the OData services SAP Gateway exposes for them. It is read-only by
construction: every request it sends to BW is an HTTP GET to `/sap/opu/odata/`. There is no tool
that creates, changes, deletes, activates or runs anything.

| Tool | What it does |
|---|---|
| `bw_find_queries` | Searches the SAP Gateway service catalog for query services by name, title or description. With `verify`, keeps only services that really are BW queries |
| `bw_describe_query` | Reads a query's `$metadata`: variables (mandatory or optional), characteristics and key figures, each with technical name and label |
| `bw_read_query` | Reads the query result: variable values, `select`, `filter`, `orderby`, `top`/`skip`; says whether more rows follow |

BW aggregates key figures over every characteristic not in `select`, the same way a front end
does when a characteristic is not drilled down.

---

## ☁️ Running on SAP BTP Cloud Foundry

Besides stdio, the server runs as an HTTP service on SAP BTP Cloud Foundry, with XSUAA OAuth in
front and a BTP destination behind. The destination uses either a shared technical user
(`BasicAuthentication`) or **principal propagation**, where each caller reaches BW as themselves
and BW applies their own authorizations.

Access is granted by one role collection, **BW MCP Analyst** (scope `analyst`). A token without
it is refused. Setup:
[docs/CENTRAL-HOSTING-SETUP.md](docs/CENTRAL-HOSTING-SETUP.md) (step-by-step) and
[docs/CLOUD-FOUNDRY.md](docs/CLOUD-FOUNDRY.md) (reference).

| Scenario | stdio only | Hosted on BTP |
|---|---|---|
| **Several analysts, one server** | not possible, no central auth | all log in via BTP, each caller's identity reaches BW |
| **Tool permissions** | none — whoever runs it can call every tool | only holders of **BW MCP Analyst** |
| **BW authorizations** | enforced through the user's own credentials | unchanged, still fully enforced — with principal propagation each caller acts as themselves |
| **Audit trail** | limited | XSUAA logs every login; with principal propagation the BW session log shows the real user |

---

## Requirements

- SAP BW/4HANA, or SAP BW 7.5 on HANA, with SAP Gateway
- The queries to be read **released "By OData"** and their `<QUERY>_SRV` service registered in
  `/IWFND/MAINT_SERVICE`; the catalog service `/IWFND/CATALOGSERVICE` (v2) active. Details:
  [Step 0 of the setup guide](docs/CENTRAL-HOSTING-SETUP.md#step-0--release-the-bw-queries-as-odata-services)
- A BW user with `S_SERVICE` for those services and analysis authorizations for the data
- Node.js 22 or later
- An MCP-compatible AI client (Claude Desktop, Claude Code, etc.)

---

## Installation

> **Two ways to run.** Locally as a **stdio** server (one user, one machine — the steps below), or
> **centrally hosted** on SAP BTP Cloud Foundry behind XSUAA OAuth for a whole team → see
> [docs/CENTRAL-HOSTING-SETUP.md](docs/CENTRAL-HOSTING-SETUP.md).

```bash
git clone https://github.com/dnic-dev/bw-modeling-mcp.git
cd bw-modeling-mcp
npm install
npm run build
```

---

## Configuration

For **local (stdio)** use, the server is configured via environment variables. For **central BTP
hosting**, connection and credentials come from the BTP destination and service bindings instead.

| Variable | Description | Required |
|---|---|---|
| `BW_URL` | BW (or Gateway) system URL, e.g. `https://myhost:50001` | yes |
| `BW_USER` | SAP user name | yes (or `BW_COOKIE_FILE`) |
| `BW_PASSWORD` | SAP password | yes (or `BW_COOKIE_FILE`) |
| `BW_CLIENT` | SAP client, e.g. `001` | yes |
| `BW_LANGUAGE` | Language for labels, e.g. `EN`, `DE` | no |
| `BW_COOKIE_FILE` | Path to a browser-exported cookie file for SAML-/OAuth-fronted systems (e.g. BW Bridge). Netscape or `name=value` format. When set, `BW_USER` / `BW_PASSWORD` are optional | no |
| `BW_MCP_SERVER_NAME` | Server name advertised in the MCP handshake. Default: `bw-modeling-mcp`. Give each instance a unique name when running several against different BW systems | no |
| `BW_MCP_SYSTEM_LABEL` | Free-text label of the connected BW system (e.g. `AP4 (BW production)`), put at the top of the MCP server instructions | no |

### Claude Desktop / Claude Code

Add to `claude_desktop_config.json`, or to `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "bw-analyst": {
      "command": "node",
      "args": ["/path/to/bw-modeling-mcp/dist/stdio.js"],
      "env": {
        "BW_URL": "https://your-bw-host:50001",
        "BW_USER": "YOUR_USER",
        "BW_PASSWORD": "YOUR_PASSWORD",
        "BW_CLIENT": "001",
        "BW_LANGUAGE": "EN"
      }
    }
  }
}
```

---

## How it works

A BW query released "By OData" gets a Gateway service `<QUERY>_SRV`. Its model always has an
entity type marked `sap:semantics="aggregate"` for the result: characteristics are its properties
with `sap:aggregation-role="dimension"`, key figures those with `"measure"`. When the query has
input-ready variables, a second entity type marked `sap:semantics="parameters"` carries them as
its key, and the result is read through it: `<QUERY>(P_VAR='x')/Results`.

`bw_describe_query` reads that model. `bw_read_query` builds the key from the variable values,
refuses missing mandatory variables and unknown names before calling BW, and passes `select`,
`filter` and `orderby` to Gateway as `$select`, `$filter` and `$orderby`. Services whose model
has no aggregate entity type are not BW queries and are refused. A service name always resolves
below `/sap/opu/odata/`, so a tool call cannot reach any other ICF service.

Source layout:

| File | Role |
|---|---|
| `src/index.ts` | MCP server, tool definitions, stdio start |
| `src/http.ts` | HTTP transport for Cloud Foundry: XSUAA OAuth, scope check, per-request client |
| `src/destination.ts` | BW client from the BTP destination — principal propagation or shared user |
| `src/scopes.ts` | The `analyst` scope and the tools it admits |
| `src/bw-client.ts` | GET-only HTTP client: basic, cookie or principal-propagation auth, Cloud Connector proxy |
| `src/query-service.ts` | Service path resolution and `$metadata` interpretation |
| `src/tools/queries.ts` | The three tools |

---

## Contributing

Issues and feature requests are welcome — please use the
[Issue templates](https://github.com/dnic-dev/bw-modeling-mcp/issues/new/choose).

---

## License

MIT

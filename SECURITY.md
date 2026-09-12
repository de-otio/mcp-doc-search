# Security policy

## Supported versions

Only the latest minor release on `main` and its most recent patch release
receive security updates. Older versions are out of support; please upgrade.

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| Older   | :x:                |

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** so we can investigate
before any public disclosure. Do **not** open a public GitHub issue for a
security concern.

Preferred channel: GitHub's
[Private vulnerability reporting](https://github.com/de-otio/mcp-doc-search/security/advisories/new)
under the repository's **Security** tab.

When you submit a report, please include:

- A description of the issue and its potential impact.
- Steps to reproduce, including any required configuration or input.
- Affected version(s) (output of `mcp-doc-search --version` or the VSIX
  filename if relevant).
- Your environment (OS, Node.js version, VS Code version).

## What to expect

- We aim to acknowledge new reports within **3 business days**.
- We will keep you updated on progress at least every 7 days while the
  issue is open.
- Once a fix is available, we will coordinate a disclosure timeline with
  you and credit you in the release notes if you wish.

## Threat model

The workspace is **untrusted**. Anyone can publish a repository that a user
clones and points this tool at, so everything under the workspace root is
treated as attacker-controlled: its directory layout, symlinks, committed
`.doc-search-index/`, `.vscode/settings.json`, `.mcp.json`, and the markdown
itself. The same applies to a configured external root. The assets being
protected are the user's home directory and everything outside the workspace,
the per-user global index store, VS Code _user_ settings, and the launch
environment. Concretely, the MCP server and CLI:

- never read or write outside the workspace, its configured external roots,
  and the per-user index directory — string containment plus a real-path
  check, so a symlink committed into the workspace cannot lead a read out;
- never delete or migrate workspace-controlled files unless a verified copy
  exists (see the threat-model comment in `src/core/indexLocation.ts`);
- treat document text returned by the tools as data, never as instructions,
  and bound what one call can return (`max_bytes` ≤ 1 MiB, `max_lines` ≤
  5000, ≤ 500 files per `multi_get` glob, per-file read ceiling);
- keep the persistent `set_context` annotations short, control-character
  free and capped in number, so they cannot become an unbounded injection
  channel into later search results;
- when running as an HTTP daemon, bind loopback only and refuse any request
  whose `Host` is not the bound loopback address and port, or that carries
  an `Origin` header at all — a browser reaching the daemon through DNS
  rebinding or a cross-origin fetch gets 403 before any handler runs.

## In scope

- Anything that lets a hostile workspace (or a document in it) read, write,
  or execute outside the boundaries above, or influence the user's other
  workspaces, global settings, or credentials.
- Anything reachable from a web page on the user's machine while the HTTP
  daemon is running.
- Malformed or oversized MCP requests that crash the server or exhaust
  memory beyond the documented caps.

## Out of scope

- A hostile **local user or process** on the same machine. The loopback
  daemon carries no authentication: any process that can open a TCP
  connection to 127.0.0.1 as the same user (or with the privileges to read
  that user's files anyway) can call it, exactly as it could read the
  workspace directly.
- Findings that require the attacker to already control the user's VS Code
  instance or user-level settings.
- Denial-of-service against the local index that requires admin access
  on the same machine.
- Vulnerabilities in third-party dependencies that have an upstream fix
  already available — please file a Dependabot-style PR instead.

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

## Out of scope

- Findings that require the attacker to already control the user's
  workspace files or VS Code instance.
- Denial-of-service against the local index that requires admin access
  on the same machine.
- Vulnerabilities in third-party dependencies that have an upstream fix
  already available — please file a Dependabot-style PR instead.

# Contributing to mcp-doc-search

Thanks for your interest in contributing!

## Getting started

**Requirements:** Node.js 18+ (Node 20+ recommended for the build matrix)

```sh
git clone https://github.com/de-otio/mcp-doc-search
cd mcp-doc-search
npm install
npm run build
```

Run tests:

```sh
npm test
npm run test:coverage
```

Run linters (must pass before committing):

```sh
npm run lint
```

## How to contribute

1. **Fork** the repo and create a topic branch from `main`.
2. Make your changes, keeping the diff focused.
3. Add or update tests as appropriate. Coverage thresholds (≥80% across
   statements / branches / functions / lines) are enforced.
4. Run `npm run lint`, `npx tsc --noEmit`, and `npm test` — all three must
   pass locally before opening a PR.
5. Open a pull request against `main`.

## What to work on

Check the [Issues](https://github.com/de-otio/mcp-doc-search/issues) tab.
Issues labeled
[`good first issue`](https://github.com/de-otio/mcp-doc-search/issues?q=label%3A%22good+first+issue%22)
are a good starting point.

## Pull request guidelines

- Keep PRs focused — one feature or fix per PR.
- Include a clear description of what changed and why.
- Reference any related issues (e.g. `Closes #42`).
- New features should include a CHANGELOG entry under `## Unreleased`.

## Reporting bugs

Open an issue with:

- Your VS Code version, OS, and `node --version`.
- Whether you're using the bundled extension, standalone CLI, or HTTP daemon.
- The command or workflow you ran.
- The error output, log excerpt, or unexpected behavior.

For suspected security issues, **do not open a public issue** — see
[SECURITY.md](SECURITY.md) instead.

## Code style

- TypeScript throughout.
- Linted with Prettier + ESLint (`npm run lint`).
- Prefer small, focused functions and explicit types at module boundaries.
- Avoid speculative abstraction — match the surrounding patterns.

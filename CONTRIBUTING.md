# Contributing

Thanks for considering a contribution. There is no build step and no runtime dependency.

## Setup

```bash
npm install
```

## Before you open a PR

```bash
npm test            # node:test, runs on the current Node (>= 22.6)
npm run typecheck   # tsc --noEmit
```

Then try the extension in a live session, in Ghostty on macOS:

```bash
pi -e /path/to/this/repo
```

and run `/open-session split-right` and `/open-session tab` at least once.

## Guidelines

- Keep the extension dependency-free: pi provides `@earendil-works/pi-coding-agent` and `typebox` as peers.
- No build step. The TypeScript source is what pi loads and what npm ships.
- No network calls, no telemetry, no data collection.
- Pass every value to the AppleScript through `argv`, never by building script source from strings.
- Tests live in `test/` and run with `node --test`. Keep pure helpers exported so they stay testable.

## Releasing

Versions are bumped manually and released by tagging:

```bash
npm version patch|minor|major
git push --follow-tags origin main
```

The `release` GitHub Action publishes to npm on `v*` tags using npm trusted publishing (OIDC), so no npm token is stored in the repo.

First publish only: the package name must exist on npm and be linked to this repo as a trusted publisher (npmjs.com, package settings, "Trusted Publisher": repository `clementprevot/pi-ghostty-session`, workflow `release.yml`, environment `npm`). Publish the first version locally with `npm publish` while logged in, then link the trusted publisher so later tags publish automatically.

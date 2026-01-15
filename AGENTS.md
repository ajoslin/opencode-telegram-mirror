# AGENTS.md

Guidance for agentic coding assistants working in this repo.
Scope: repository root (applies to all files).

## Overview
- Project: Telegram mirror for OpenCode sessions.
- Primary runtime: Bun (root) with a Next.js app in `diff-viewer/`.
- Language: TypeScript with ESM modules and strict type checking.
- Keep changes small and aligned with existing style.

## Repo Layout
- `src/`: Bun-based Telegram mirror bot.
- `diff-viewer/`: Next.js app for viewing diffs.
- `tsconfig.json`: root TS config (strict, ESM).
- `diff-viewer/tsconfig.json`: Next.js TS config.

## Commands (Root - Telegram Mirror)
Install dependencies:
  - `bun install`
Run the bot:
  - `bun run start`
Run from source (explicit):
  - `bun run src/main.ts`
Typecheck:
  - `bun run typecheck`

## Commands (diff-viewer - Next.js)
Install dependencies (from `diff-viewer/`):
  - `npm install`
Dev server:
  - `npm run dev`
Build:
  - `npm run build`
Start production server:
  - `npm run start`
Lint:
  - `npm run lint`
Lint a single file (example):
  - `npx next lint --file app/page.tsx`
Typecheck (manual):
  - `npx tsc --noEmit`

## Tests
- No test runner is configured in either package.
- Single-test command: N/A (document here if tests are added).

## Single-File Checks
- Root: `bun run typecheck` validates `src/**/*`.
- Diff-viewer typecheck (manual): `npx tsc --noEmit`.
- Lint single file: `npx next lint --file app/page.tsx`.
- Use `npm run lint -- --file <path>` if you prefer npm.

## TypeScript & Module Conventions
- TypeScript `strict` is enabled in both packages.
- ESM modules are used; prefer `import`/`export` syntax.
- Use `import type` for type-only imports (see `src/telegram.ts`).
- Prefer explicit return types for exported/public functions.
- Avoid `any`; use `unknown` + narrowing when needed.
- Prefer `interface` for object shapes and `type` for unions.
- Keep JSON parsing typed (cast to known interfaces).
- Prefer `const` over `let`; keep functions small and focused.

## Formatting
- Indentation: 2 spaces.
- Semicolons are omitted in existing files.
- Root `src/` uses double quotes.
- `diff-viewer/` uses single quotes.
- Keep line length readable (roughly 100–120 chars).
- Use trailing commas in multi-line objects/arrays.
- Separate logical blocks with blank lines.

## Imports
- Order: Node built-ins (`node:`), external deps, internal modules.
- Keep internal imports relative (no absolute paths in root).
- In `diff-viewer/`, `@/*` path alias is available.
- Avoid unused imports; remove when refactoring.

## Naming
- Files: kebab-case or lower-case with hyphens (existing pattern).
- Functions: `camelCase`.
- Classes: `PascalCase`.
- Types/interfaces: `PascalCase`.
- Constants: `UPPER_SNAKE_CASE` when truly constant.
- Prefer descriptive names (e.g., `sessionId`, `updatesUrl`).

## Error Handling
- Use `try/catch` around network and IO calls.
- Log errors with context and return safe defaults.
- Throw `Error` for fatal conditions (e.g., invalid bot token).
- Use `String(error)` when logging unknown errors.
- Prefer early returns for invalid state.
- Use `console.error` + `process.exit(1)` only for fatal startup errors.

## Logging
- Root uses `createLogger()` and `log(level, message, extra)`.
- Use `log("info" | "warn" | "error" | "debug", ...)` in bot code.
- Avoid `console.log` except for fatal startup errors.

## Async & Concurrency
- Use `async/await` for clarity.
- Avoid blocking loops; use `await Bun.sleep(...)` for backoff.
- If retrying, log retry context and keep delays reasonable.

## Data & API Handling
- Validate request payloads before use.
- When reading env vars, allow file config to be overridden.
- Normalize ids to strings for comparisons.
- Keep Telegram API interactions resilient (retry without Markdown).

## Next.js (diff-viewer) Guidelines
- App Router under `diff-viewer/app/`.
- Mark client components with `'use client'`.
- Default-export page components.
- API routes live in `app/api/.../route.ts`.
- Use `NextResponse.json` for API responses.
- Guard against missing env vars (use fallbacks).
- Use `kv` for storing diff data with TTL.

## Styling (diff-viewer)
- Use existing class names and inline styles sparingly.
- Keep style values in CSS variables when possible.
- Maintain small, focused components.

## Config & Environment
- Root config loads from:
  - `~/.config/opencode/telegram.json`
  - `<repo>/.opencode/telegram.json`
- Environment variables override config:
  - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_UPDATES_URL`, `TELEGRAM_SEND_URL`
- Diff viewer base URL uses `VERCEL_URL` or `NEXT_PUBLIC_BASE_URL`.

## Dependency Management
- Root uses Bun; avoid adding npm scripts unless required.
- `diff-viewer/` uses npm; avoid mixing yarn/pnpm here.
- Keep dependency upgrades minimal and justified.

## Generated Files
- Do not edit files under `diff-viewer/.next/`.
- Do not commit `dist/` or `node_modules/`.
- Root build output goes to `dist/` (see `tsconfig.json`).

## Code Organization
- Prefer small helpers over large monolithic functions.
- Keep side effects near the edges (IO, network).
- Keep types co-located with their usage when small.

## Updating This File
- Update commands if scripts change.
- Add new tool or lint rules as they are introduced.
- Keep this file around ~150 lines.

## Cursor/Copilot Rules
- No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` found.
- If added later, summarize them here.

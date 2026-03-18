# AGENTS.md — Coding Agent Guidelines

## Runtime & Build

- **Runtime**: Bun (NOT Node.js). All commands use `bun`, never `node` or `npm run`.
- **Install**: `bun install`
- **Run simulation**: `bun run src/main.ts` (or `bun run sim`)
- **Type check**: `npx tsc --noEmit` — this is the ONLY code quality gate. Run after every change.
- **No test framework**: No tests exist. No jest, vitest, or bun:test.
- **No linter/formatter**: No eslint, prettier, or biome configured.
- **No CI/CD**: No GitHub Actions or other pipelines.

## Project Structure

```
src/
  main.ts              CLI entry point (parseArgs from "util")
  types.ts             All shared type definitions (interfaces, enums, type aliases)
  config.ts            Constants and default config
  rng.ts               Seeded PRNG (mulberry32) + Gaussian RNG
  mix.ts               ValidatorMix parsing and formatting
  fetch-all.ts         Standalone data pre-fetch script
  data/
    fetcher.ts         Binance API client with retry logic
    cache.ts           Disk cache (consolidated JSON in data/ dir)
    interpolator.ts    1m candles -> 6s block interpolation
  sim/
    engine.ts          Simulation orchestrator (runSimulation)
    chain.ts           Block-by-block chain state machine
    validator.ts       ValidatorAgent interface + HonestValidator
    malicious.ts       All adversary validator classes
    price-endpoint.ts  Price data wrapper with per-validator jitter
  analysis/
    scenarios.ts       Named scenario runners (honest, sweep-*, research)
    research-criteria.ts  Scoring weights and thresholds
    research-report.ts    Report generation for research scenario
  viz/
    server.ts          Bun.serve() with /api/meta and /api/data endpoints
    aggregation.ts     Server-side OHLC/line/deviation aggregation
    writer.ts          ChunkWriter for .simdata columnar format
    template.html      Interactive chart viewer (Lightweight Charts v4.1.3)
```

## Dependencies

Zero runtime dependencies. Dev-only:
- `@types/bun` — Bun type definitions
- `typescript` — type checking only (no compilation step)

## TypeScript Configuration

- `strict: true` — all strict checks enabled
- `target: ESNext`, `module: ESNext`, `moduleResolution: bundler`
- `types: ["bun-types"]`

## Code Style

### Imports

- **Always use `.js` extension** on relative imports (ESM requirement):
  ```ts
  import { Bump } from "../types.js";
  import type { SimulationConfig } from "./types.js";
  ```
- **Separate value and type imports** — use `import type` for type-only:
  ```ts
  import { Bump } from "../types.js";                    // value (enum used at runtime)
  import type { BumpSubmission } from "../types.js";      // type-only
  ```
- **Node built-ins**: bare specifiers without `node:` prefix:
  ```ts
  import { join } from "path";
  import { mkdirSync, existsSync } from "fs";
  import { parseArgs } from "util";
  ```

### Naming Conventions

| Kind | Convention | Examples |
|------|-----------|----------|
| Variables, functions, parameters | `camelCase` | `fetchBatch`, `pricePoints`, `blockIndex` |
| Classes, interfaces, types, enums | `PascalCase` | `HonestValidator`, `SimulationConfig`, `Bump` |
| Constants (module-level) | `UPPER_SNAKE_CASE` | `BLOCK_TIME_SECONDS`, `BLOCKS_PER_CHUNK` |
| File names | `kebab-case.ts` | `price-endpoint.ts`, `research-criteria.ts` |

### Exports

- **Named exports only** — no default exports anywhere in the codebase.
- Export at declaration site: `export function ...`, `export class ...`, `export const ...`

### Types

- **Shared types** go in `src/types.ts`. Module-specific types stay in their module.
- **Interfaces** for data shapes: `SimulationConfig`, `BlockMetrics`, `Candle`.
- **Type aliases** for unions and computed types: `type ValidatorMixEntry = number | { ... }`.
- **Enums** with explicit values: `enum Bump { Up = 1, Down = -1 }`.
- **`readonly`** on immutable interface/class fields: `readonly index: number`.
- **Constructor type aliases** when needed: `type ValidatorCtor = new (...) => ValidatorAgent`.

### Functions

- **Top-level named functions** for exports: `export function runSimulation(...)`.
- **`function` declarations** for file-private helpers: `function lowerBound(...)`.
- **Arrow functions** for callbacks and short expressions: `.map((c) => ({ ... }))`.
- **Explicit return types** on exported functions.
- **`async function`** (not async arrows) for async exports.

### Classes

- **TypeScript `private`** keyword (not `#` private fields).
- **`readonly`** for immutable fields set in constructor.
- **Manual assignment** in constructors (no parameter properties):
  ```ts
  constructor(index: number, endpoint: PriceEndpoint) {
    this.index = index;
    this.endpoint = endpoint;
  }
  ```
- **Interface + implementation** pattern: `ValidatorAgent` interface, `HonestValidator implements ValidatorAgent`.

### Error Handling

- **CLI validation errors**: `console.error(msg); process.exit(1)`.
- **Library/logic errors**: `throw new Error("descriptive message")`.
- **API retries**: exponential backoff loop (`for attempt = 0..2`, `Bun.sleep(2^attempt * 1000)`).
- **Never** use empty catch blocks.

### Formatting

- **2-space indentation**.
- **Semicolons** always.
- **Double quotes** for import paths; template literals for interpolation.
- **Trailing commas** in multi-line arrays/objects/parameters.
- **`const`** by default; `let` only when reassignment is needed.
- **Numeric separators** for large numbers: `1_000_000`, `10_000`.

### Comments

- **JSDoc `/** */`** for function and class documentation.
- **Section dividers**: `// ── Section Name ──`.
- **Triple-slash `///`** for struct field docs in `types.ts`.
- **Inline `//`** for non-obvious logic only. Don't over-comment.
- **`// TODO:`** for future work items.

## Bun-Specific APIs

Use Bun APIs instead of Node.js equivalents where available:
- `Bun.file(path)` / `Bun.write(path, data)` for file I/O
- `Bun.serve({ port, fetch })` for HTTP servers
- `Bun.sleep(ms)` instead of `setTimeout` wrappers
- `Bun.spawn([cmd, ...args])` for subprocesses
- `import.meta.dir` for directory of current file
- `Bun.argv` for CLI arguments

## Key Architectural Patterns

- **Columnar data format**: `.simdata` directories use chunked columnar JSON (arrays of numbers) not array-of-objects. See `BLOCKS_PER_CHUNK` in `types.ts`.
- **BlockSink callback**: `engine.ts` streams `BlockMetrics` via a callback instead of building arrays — critical for multi-million-block simulations.
- **Validator registry**: `engine.ts` has a `VALIDATOR_REGISTRY` mapping string names to constructor types. New validator types must be registered there.
- **Auto-epsilon**: `maxBlockDelta(pricePoints) / validatorCount` — the default epsilon calculation.
- **Seeded PRNG**: All randomness flows through `mulberry32(seed)` for reproducibility. Never use `Math.random()`.

## Gotchas

- Year-long simulations produce ~5.2M blocks and take minutes to run.
- `import.meta.dir` in `server.ts` and `cache.ts` resolves relative to the source file, not CWD.
- The `.js` extension in imports is mandatory — TypeScript won't add it and Bun requires it.
- `template.html` uses `/*DATA_PLACEHOLDER*/null` for embedded mode detection. Don't change this pattern.

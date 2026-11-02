// Module facade: consumers outside `turn-failure-signal` import through this
// index (enforced by scripts/check-module-boundaries.mjs).
export { createTurnFailureSignalService } from "./application/use-cases.js";
export { createPostgresTurnFailureSignalStore } from "./adapters/postgres.js";
export { readCanaryState } from "./canary-state.js";
export { resolveTurnFailureSignalConfig } from "./config.js";

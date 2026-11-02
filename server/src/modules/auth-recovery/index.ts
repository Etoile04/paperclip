// Module facade: consumers outside `auth-recovery` import through this index
// (enforced by scripts/check-module-boundaries.mjs).
export {
  AUTH_RECOVERY_ERROR_CODE,
  AUTH_RECOVERY_GREEN_ADAPTER_TYPES,
  AUTH_RECOVERY_WAKE_REASON,
} from "./domain/policy.js";
export { createAuthRecoveryService } from "./application/use-cases.js";
export { createPostgresAuthRecoveryStore } from "./adapters/postgres.js";

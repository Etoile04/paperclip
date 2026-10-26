-- NFM-5775 (ADR-026 §6): per-slot canary episode attribution. The credential
-- slot id (a safe identifier, never a credential value) that produced the
-- green observation rides on the episode row so the R4 errorReason annotation
-- keeps its slot attribution across retry sweeps. Nullable: callers that do
-- not know the slot (single-slot operation today) leave it null.

ALTER TABLE "auth_recovery_episodes"
  ADD COLUMN IF NOT EXISTS "green_slot_id" text;

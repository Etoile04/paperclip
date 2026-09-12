import fs from "node:fs/promises";
import path from "node:path";

// NFM-4784 remedy (c): secondary liveness via the agent session transcript.
// A transcript that is still advancing proves work continues even when the
// output channel is severed or silent; a static transcript is stalled.

/**
 * Grace window after the silence start within which a transcript mtime is
 * still considered "not newer than the silence" — tolerates clock jitter and
 * an mtime recorded moments before the channel froze.
 */
export const TRANSCRIPT_GROWTH_GRACE_MS = 60 * 1000;

export type RunTranscriptLiveness = {
  status: "growing" | "static" | "unavailable";
  path: string;
  mtimeMs: number | null;
  sizeBytes: number | null;
};

interface TranscriptStat {
  mtimeMs: number;
  sizeBytes: number;
}

/**
 * Stat a transcript location. A file path stats the file directly; a directory
 * path stats its newest *.jsonl entry (the live session transcript when the
 * session id was not yet known at adapter start). Returns null when nothing
 * statable exists at the path (never throws — liveness probes must not break
 * the scan loop).
 */
export async function statTranscript(transcriptPath: string): Promise<TranscriptStat | null> {
  if (transcriptPath.trim().length === 0) return null;
  try {
    const direct = await fs.stat(transcriptPath);
    if (direct.isFile()) {
      return { mtimeMs: direct.mtimeMs, sizeBytes: direct.size };
    }
    if (!direct.isDirectory()) return null;
    const entries = await fs.readdir(transcriptPath);
    let newest: TranscriptStat | null = null;
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const entryStat = await fs.stat(path.join(transcriptPath, entry));
      if (!entryStat.isFile()) continue;
      if (!newest || entryStat.mtimeMs > newest.mtimeMs) {
        newest = { mtimeMs: entryStat.mtimeMs, sizeBytes: entryStat.size };
      }
    }
    return newest;
  } catch {
    return null;
  }
}

/**
 * Probe the transcript recorded on the run record (never inferred). The run's
 * transcriptPath may be a session file or a project directory.
 *
 * `growing` means the transcript was written after the silence window began:
 * work is alive but unobservable through the output channel. `static` means
 * the transcript predates the silence window. `unavailable` means no statable
 * transcript exists at the persisted path (remote execution, deleted file, …).
 */
export async function probeRunTranscriptLiveness(input: {
  transcriptPath: string | null;
  silenceStartedAt: Date | null;
  now: Date;
}): Promise<RunTranscriptLiveness> {
  const basePath = input.transcriptPath?.trim() ?? "";
  if (basePath.length === 0) {
    return { status: "unavailable", path: "", mtimeMs: null, sizeBytes: null };
  }
  const stat = await statTranscript(basePath);
  if (!stat) {
    return { status: "unavailable", path: basePath, mtimeMs: null, sizeBytes: null };
  }
  const silenceStartMs = input.silenceStartedAt
    ? input.silenceStartedAt.getTime()
    : null;
  const growing =
    silenceStartMs !== null &&
    stat.mtimeMs > silenceStartMs + TRANSCRIPT_GROWTH_GRACE_MS;
  return {
    status: growing ? "growing" : "static",
    path: basePath,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.sizeBytes,
  };
}

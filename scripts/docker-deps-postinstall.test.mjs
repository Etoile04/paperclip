// Fork-adapted from paperclipai/paperclip@master blob
// fc048a3e715f591e8801d60aec0acba8eaa666f0
// (scripts/docker-deps-postinstall.test.mjs). The upstream test asserts the
// Copilot postinstall pipeline (postinstall hooks in packages/paperclip-runner
// and server, their scripts/install-copilot-assets.mjs entrypoints, and the
// deps-stage COPY inputs that make them runnable pre-compilation). This fork's
// deps stage predates that pipeline, so the verbatim assertions cannot hold
// here. This adaptation keeps the fork-invariant half of the same contract —
// the deps stage parses and every context-root COPY source it references
// exists — which is the drift-signal the upstream-defined policy job ("Validate
// Dockerfile deps stage") needs until the fork adopts the upstream
// postinstall pipeline. Do not delete; re-sync with upstream when parity lands.
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url));

test("dependency-stage COPY inputs resolve inside the repository", async () => {
  const dockerfile = await readFile(path.join(repo, "Dockerfile"), "utf8");
  const stage = dockerfile.split(/^FROM .* AS deps\s*$/im)[1]?.split(/^FROM /im)[0];
  assert.ok(stage, "dependency stage exists");
  const beforeInstall = stage.split(/^RUN pnpm install/m)[0];
  const missing = [];
  for (const line of beforeInstall.split("\n")) {
    if (!line.startsWith("COPY ") || line.includes("--")) continue;
    const args = line.trim().split(/\s+/).slice(1);
    args.pop(); // destination
    for (const source of args) {
      if (source.includes("[")) continue; // glob-style sources are validated by the build itself
      try {
        await stat(path.join(repo, source));
      } catch {
        missing.push(source);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    "deps-stage COPY sources missing from the repository (broken docker build)",
  );
});

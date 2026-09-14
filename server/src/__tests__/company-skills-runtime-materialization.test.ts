import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { companies, companySkills, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres runtime materialization tests on this host: `
    + `${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HOLLOW_MARKDOWN = "---\nname: Hollow Coach\ndescription: Descriptor only.\n---\n";
const FULL_MARKDOWN = "# Full Coach\n\nReal body with instructions.\n";

function runtimeRootFor(paperclipHome: string, companyId: string) {
  return path.join(paperclipHome, "instances", "default", "skills", companyId, "__runtime__");
}

describeEmbeddedPostgres("companySkillService runtime materialization (NFM-4856)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySkillService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let paperclipHome: string | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runtime-materialization-");
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-materialization-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    db = createDb(tempDb.connectionString);
    svc = companySkillService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companySkills);
    await db.delete(companies);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (paperclipHome) {
      await fs.rm(paperclipHome, { recursive: true, force: true });
    }
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedSkill(input: {
    companyId: string;
    slug: string;
    markdown: string;
    sourceType?: "catalog" | "local_path";
    sourceLocator?: string | null;
  }) {
    const skillId = randomUUID();
    const key = `company/${input.companyId}/${input.slug}`;
    await db.insert(companySkills).values({
      id: skillId,
      companyId: input.companyId,
      key,
      slug: input.slug,
      name: input.slug,
      description: null,
      markdown: input.markdown,
      sourceType: input.sourceType ?? "catalog",
      sourceLocator: input.sourceLocator ?? path.join(os.tmpdir(), `dead-source-${randomUUID()}`),
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: input.sourceType ?? "catalog" },
    });
    return { skillId, key };
  }

  it("F1: refuses to materialize a descriptor-only (frontmatter-only) stored copy", async () => {
    const companyId = await seedCompany();
    const { key } = await seedSkill({ companyId, slug: "hollow-coach", markdown: HOLLOW_MARKDOWN });

    const entries = await svc.listRuntimeSkillEntries(companyId);
    const hollow = entries.find((entry) => entry.key === key);

    expect(hollow).toMatchObject({ sourceStatus: "missing" });
    expect(hollow?.missingDetail).toContain("descriptor");
    const runtimeRoot = runtimeRootFor(paperclipHome!, companyId);
    const materializedDirs = await fs.readdir(runtimeRoot).catch(() => [] as string[]);
    expect(materializedDirs.some((dir) => dir.startsWith("hollow-coach"))).toBe(false);
  });

  it("F1: refuses registration of a frontmatter-only SKILL.md source directory", async () => {
    const companyId = await seedCompany();
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hollow-import-"));
    await fs.writeFile(path.join(skillDir, "SKILL.md"), HOLLOW_MARKDOWN, "utf8");

    await expect(svc.importFromSource(companyId, skillDir)).rejects.toThrow(/frontmatter-only/);
    await fs.rm(skillDir, { recursive: true, force: true });
  });

  it("F1: refuses registration of a frontmatter-only single-file source", async () => {
    const companyId = await seedCompany();
    const skillFile = path.join(os.tmpdir(), `paperclip-hollow-file-${randomUUID()}.md`);
    await fs.writeFile(skillFile, HOLLOW_MARKDOWN, "utf8");

    await expect(svc.importFromSource(companyId, skillFile)).rejects.toThrow(/frontmatter-only/);
    await fs.rm(skillFile, { force: true });
  });

  it("F2: GCs legacy and stale hash-suffixed dirs for the same slug after materializing", async () => {
    const companyId = await seedCompany();
    const { key } = await seedSkill({ companyId, slug: "gc-coach", markdown: FULL_MARKDOWN });

    const runtimeRoot = runtimeRootFor(paperclipHome!, companyId);
    await fs.mkdir(path.join(runtimeRoot, "gc-coach"), { recursive: true });
    await fs.writeFile(path.join(runtimeRoot, "gc-coach", "SKILL.md"), "legacy june-era copy", "utf8");
    await fs.mkdir(path.join(runtimeRoot, "gc-coach--00000000"), { recursive: true });

    const gcLogSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const entries = await svc.listRuntimeSkillEntries(companyId);
    const entry = entries.find((candidate) => candidate.key === key);

    expect(entry?.sourceStatus).toBe("stale");
    const remaining = await fs.readdir(runtimeRoot);
    expect(remaining).toContain(entry!.runtimeName);
    expect(remaining).not.toContain("gc-coach");
    expect(remaining).not.toContain("gc-coach--00000000");
    expect(gcLogSpy).toHaveBeenCalledWith(
      expect.stringContaining(`skills runtime GC: removed stale materialized dir "gc-coach"`),
    );
    expect(gcLogSpy).toHaveBeenCalledWith(
      expect.stringContaining(`skills runtime GC: removed stale materialized dir "gc-coach--00000000"`),
    );
  });

  it("F2: does not rewrite an already-current materialized copy", async () => {
    const companyId = await seedCompany();
    const { key } = await seedSkill({ companyId, slug: "stable-coach", markdown: FULL_MARKDOWN });

    const first = await svc.listRuntimeSkillEntries(companyId);
    const entry = first.find((candidate) => candidate.key === key);
    const skillDir = path.join(runtimeRootFor(paperclipHome!, companyId), entry!.runtimeName);
    const firstStat = await fs.stat(skillDir);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await svc.listRuntimeSkillEntries(companyId);
    const secondStat = await fs.stat(skillDir);

    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
    expect(await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).toBe(FULL_MARKDOWN);
  });

  it("F3: materializes only in-scope keys when materializeKeys is provided", async () => {
    const companyId = await seedCompany();
    const { key: wantedKey } = await seedSkill({ companyId, slug: "wanted-coach", markdown: FULL_MARKDOWN });
    await seedSkill({ companyId, slug: "unwanted-coach", markdown: FULL_MARKDOWN });

    const entries = await svc.listRuntimeSkillEntries(companyId, {
      materializeKeys: new Set(["wanted-coach"]),
    });

    const runtimeRoot = runtimeRootFor(paperclipHome!, companyId);
    const dirs = await fs.readdir(runtimeRoot);
    const wanted = entries.find((entry) => entry.key === wantedKey);
    const unwanted = entries.find((entry) => entry.key.endsWith("unwanted-coach"));

    expect(wanted?.sourceStatus).toBe("stale"); // dead source + in scope
    expect(dirs).toContain(wanted!.runtimeName);
    expect(unwanted?.sourceStatus).toBe("missing");
    expect(dirs.some((dir) => dir.startsWith("unwanted-coach"))).toBe(false);
  });

  it("F3: empty materializeKeys set materializes nothing", async () => {
    const companyId = await seedCompany();
    await seedSkill({ companyId, slug: "scoped-coach", markdown: FULL_MARKDOWN });

    await svc.listRuntimeSkillEntries(companyId, { materializeKeys: new Set<string>() });

    const runtimeRoot = runtimeRootFor(paperclipHome!, companyId);
    const dirs = await fs.readdir(runtimeRoot).catch(() => [] as string[]);
    expect(dirs.some((dir) => dir.startsWith("scoped-coach"))).toBe(false);
  });

  it("F3: full skill keys are matched, not only slug segments", async () => {
    const companyId = await seedCompany();
    const { key } = await seedSkill({ companyId, slug: "keyed-coach", markdown: FULL_MARKDOWN });

    const entries = await svc.listRuntimeSkillEntries(companyId, {
      materializeKeys: new Set([key.toUpperCase()]),
    });

    const runtimeRoot = runtimeRootFor(paperclipHome!, companyId);
    const dirs = await fs.readdir(runtimeRoot);
    const entry = entries.find((candidate) => candidate.key === key);
    expect(entry?.sourceStatus).toBe("stale");
    expect(dirs).toContain(entry!.runtimeName);
  });

  it("F4: flags dead local sources as stale instead of silently tolerating them", async () => {
    const companyId = await seedCompany();
    const deadLocator = path.join(os.tmpdir(), `deleted-workspace-${randomUUID()}`);
    // Catalog-type rows with a materialized sourceLocator skip the reconcile
    // pruner, mirroring the NFM-4851 audit state: a registration whose source
    // directory was deleted keeps materializing from the stored copy.
    const { key } = await seedSkill({
      companyId,
      slug: "dead-source-coach",
      markdown: FULL_MARKDOWN,
      sourceType: "catalog",
      sourceLocator: deadLocator,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entries = await svc.listRuntimeSkillEntries(companyId, {
      materializeKeys: new Set(["dead-source-coach"]),
    });
    const entry = entries.find((candidate) => candidate.key === key);

    expect(entry?.sourceStatus).toBe("stale");
    expect(entry?.missingDetail).toContain(deadLocator);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("local source is missing"));
    const runtimeRoot = runtimeRootFor(paperclipHome!, companyId);
    const dirs = await fs.readdir(runtimeRoot);
    expect(dirs).toContain(entry!.runtimeName);
  });
});

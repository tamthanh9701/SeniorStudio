// @vitest-environment node
// Database-level guarantees that no route test can see, because they live in the
// SQL functions: the hard delete's counts and predicate, the packet subset and
// library rules, enqueue/delete serialization, the mask sweeper, and the reference
// capacity cap.
//
// Skipped unless RUN_DB_INTEGRATION=1 and TEST_DATABASE_URL are set, so the normal
// unit run never needs a database. The fixture lives in ./support/db-harness.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectHarness, dbSuite, type Harness } from "./support/db-harness";

let harness: Harness;

dbSuite("style guards (database)", () => {
  beforeAll(async () => {
    harness = await connectHarness();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("enqueues a plain packet for a confirmed style", { timeout: 30_000 }, async () => {
    const style = await harness.createStyle("Guards enqueue", { references: 1 });
    const job = await harness.enqueueStyleJob(harness.packet(style.styleId, style.revision, style.references), style.styleId);
    expect(job.status).toBe("queued");
    expect((job.input as { reference_ids: string[] }).reference_ids).toEqual([style.references[0].id]);
  });

  it("hard-deletes a style with terminal jobs and reports its own objects", { timeout: 30_000 }, async () => {
    const { admin, workspaceId } = harness;
    const style = await harness.createStyle("Guards delete", { references: 1, jobStatuses: ["succeeded", "failed", "canceled"] });
    const assetId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const versionPath = `${workspaceId}/styles/${style.styleId}/outputs/${assetId}/${versionId}/source.png`;
    await admin.query("insert into public.assets(id, style_id, name, kind) values($1,$2,'guards asset','generated')", [assetId, style.styleId]);
    await admin.query(
      "insert into public.asset_versions(id, asset_id, source, storage_path, mime_type, width, height, byte_size) values($1,$2,'web_openai',$3,'image/png',8,8,8)",
      [versionId, assetId, versionPath],
    );
    const rows = await harness.asMember<{ result: { images: number; references: number; jobs: number; storage_paths: string[] } }>(
      "select public.delete_style_hard($1) as result",
      [style.styleId],
      { commit: true },
    );
    const result = rows[0].result;
    expect(result).toMatchObject({ images: 1, references: 1, jobs: 3 });
    expect(result.storage_paths).toEqual(expect.arrayContaining([versionPath, `${workspaceId}/styles/${style.styleId}/${style.references[0].id}.png`]));
    // Only this style's objects, never anything else in the workspace.
    for (const path of result.storage_paths) expect(path.startsWith(`${workspaceId}/styles/${style.styleId}/`)).toBe(true);
    expect((await admin.query("select count(*)::int as n from public.styles where id=$1", [style.styleId])).rows[0].n).toBe(0);
  });

  it("refuses a style that is still generating, and one that does not exist", { timeout: 30_000 }, async () => {
    const style = await harness.createStyle("Guards busy", { references: 1, jobStatuses: ["processing"] });
    await expect(harness.asMember("select public.delete_style_hard($1)", [style.styleId])).rejects.toThrow(/STYLE_BUSY/);
    await expect(harness.asMember("select public.delete_style_hard($1)", [crypto.randomUUID()])).rejects.toThrow(/STYLE_NOT_FOUND/);
  });

  it("accepts a borrowed reference from the same library and records it", { timeout: 30_000 }, async () => {
    const { admin, workspaceId, userId } = harness;
    const libraryId = crypto.randomUUID();
    harness.track("library", libraryId);
    await admin.query("insert into public.style_libraries(id, workspace_id, name) values($1,$2,'Guards library')", [libraryId, workspaceId]);
    const lender = await harness.createStyle("Guards lender", { references: 1 });
    const borrower = await harness.createStyle("Guards borrower", { references: 1 });
    await admin.query("update public.styles set library_id=$1 where id=any($2::uuid[])", [libraryId, [lender.styleId, borrower.styleId]]);
    const rows = await harness.asMember<{ input: { reference_ids: string[] }; style_generation: { metadata?: { library_reference_ids?: string[] } } }>(harness.enqueueSql, [
      borrower.styleId,
      userId,
      harness.packet(borrower.styleId, borrower.revision, [...borrower.references, ...lender.references], [lender.references[0].id]),
    ]);
    expect(rows[0].input.reference_ids).toEqual([borrower.references[0].id, lender.references[0].id]);
    expect(rows[0].style_generation.metadata?.library_reference_ids).toEqual([lender.references[0].id]);
  });

  it("refuses a borrowed reference from another workspace", { timeout: 30_000 }, async () => {
    const { admin } = harness;
    const otherWorkspace = crypto.randomUUID();
    const otherLibrary = crypto.randomUUID();
    const otherStyle = crypto.randomUUID();
    const otherRef = crypto.randomUUID();
    // Everything the test creates belongs to the throwaway workspace, so cleanup
    // deletes the cast-offs with it even when an assertion fails midway.
    harness.track("workspace", otherWorkspace);
    harness.track("library", otherLibrary);
    await admin.query("insert into public.workspaces(id, name) values($1,'Guards foreign')", [otherWorkspace]);
    await admin.query("insert into public.style_libraries(id, workspace_id, name) values($1,$2,'Guards foreign library')", [otherLibrary, otherWorkspace]);
    await admin.query("insert into public.styles(id, workspace_id, name, status, library_id) values($1,$2,'Guards foreign style','active',$3)", [otherStyle, otherWorkspace, otherLibrary]);
    await admin.query(
      "insert into public.style_references(id, style_id, storage_path, mime_type, byte_size, width, height, content_hash) values($1,$2,$3,'image/png',8,8,8,$4)",
      [otherRef, otherStyle, `${otherWorkspace}/styles/${otherStyle}/${otherRef}.png`, "f".repeat(64)],
    );
    // The borrower claims the foreign library (library_id is member-writable) and
    // asks to borrow its reference.
    const borrower = await harness.createStyle("Guards thief", { references: 1 });
    await admin.query("update public.styles set library_id=$1 where id=$2", [otherLibrary, borrower.styleId]);
    await expect(
      harness.asMember(harness.enqueueSql, [borrower.styleId, harness.userId, harness.packet(borrower.styleId, borrower.revision, borrower.references, [otherRef])]),
    ).rejects.toThrow(/REFERENCE_NOT_FOUND/);
  });

  it("accepts a subset of the confirmed snapshot", { timeout: 30_000 }, async () => {
    const style = await harness.createStyle("Guards subset", { references: 3 });
    const job = await harness.enqueueStyleJob(harness.packet(style.styleId, style.revision, style.references.slice(0, 2)), style.styleId);
    expect((job.input as { reference_ids: string[] }).reference_ids).toEqual([style.references[0].id, style.references[1].id]);
  });

  it("serialises an enqueue against the hard delete", { timeout: 60_000 }, async () => {
    const { admin, userId } = harness;
    const style = await harness.createStyle("Guards race", { references: 1 });
    const second = await harness.newSession();
    try {
      await admin.query("begin");
      await admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: userId })]);
      await admin.query("select public.delete_style_hard($1)", [style.styleId]);

      await second.query("begin");
      await second.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: userId })]);
      const pending = second
        .query(harness.enqueueSql, [style.styleId, userId, harness.packet(style.styleId, style.revision, style.references)])
        .then(() => "completed", (error: Error) => `rejected: ${error.message}`);

      // The server reports the wait, so it is observed rather than assumed: the
      // blocked backend holds an ungranted lock on this transaction's xid. The
      // waiting statement's text is not reliable through the transaction pooler.
      let waiting = false;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !waiting) {
        const waitState = await admin.query(
          `select count(*)::int as waiting
             from pg_locks l
            where not l.granted and l.locktype = 'transactionid'
              and l.transactionid = pg_current_xact_id_if_assigned()::text::xid
              and l.pid <> pg_backend_pid()`,
        );
        waiting = (waitState.rows[0].waiting as number) > 0;
        if (!waiting) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 25);
          await promise;
        }
      }
      expect(waiting, "the enqueue should be waiting on the style row").toBe(true);
      // Still unfinished while the delete holds the row.
      expect(await Promise.race([pending, Promise.resolve("pending")])).toBe("pending");

      await admin.query("commit");
      await expect(pending).resolves.toMatch(/rejected: .*STYLE_NOT_FOUND/);
      expect((await admin.query("select count(*)::int as n from public.ai_jobs where style_id=$1", [style.styleId])).rows[0].n).toBe(0);
      await second.query("rollback");
    } finally {
      await second.end();
    }
  });

  it("claims expired and terminal-job masks but leaves live ones", { timeout: 30_000 }, async () => {
    const { admin, workspaceId, userId } = harness;
    const style = await harness.createStyle("Guards masks", { references: 1 });
    const mask = async (expiresIn: string, jobId: string | null) => {
      const id = crypto.randomUUID();
      await admin.query(
        `insert into public.ai_job_inputs(id, workspace_id, project_id, style_id, asset_id, parent_version_id, kind, storage_path, mime_type, width, height, byte_size, expires_at, job_id)
         values($1,$2,null,$3,null,null,'mask',$4,'image/png',8,8,8, now() + ($5)::interval, $6)`,
        [id, workspaceId, style.styleId, `${workspaceId}/styles/${style.styleId}/job-inputs/${id}/mask.png`, expiresIn, jobId],
      );
      harness.track("mask", id);
      return id;
    };
    const terminalJobId = crypto.randomUUID();
    await admin.query(
      `insert into public.ai_jobs(id, workspace_id, module, requested_by, operation, provider, model, status, input, style_id, output, completed_at)
       values($1,$2,'style',$3,'inpaint','openai','openai/gpt-image-2','failed',$4::jsonb,$5,'{}'::jsonb, now())`,
      [terminalJobId, workspaceId, userId, JSON.stringify({ prompt: "fixture", count: 1, size: "1024x1024", quality: "low", style_id: style.styleId, original_prompt: "fixture", reference_ids: [] }), style.styleId],
    );
    harness.track("job", terminalJobId);
    const abandoned = await mask("-2 hours", null);
    const attached = await mask("1 hour", terminalJobId);
    const live = await mask("1 hour", null);

    const claimed = (await harness.asService("select id from public.claim_expired_job_masks(50)", [], { commit: true })).map((row) => row.id as string);
    expect(claimed).toEqual(expect.arrayContaining([abandoned, attached]));
    expect(claimed).not.toContain(live);
    const remaining = (await admin.query("select id from public.ai_job_inputs where id = any($1::uuid[])", [[abandoned, attached, live]])).rows.map((row) => row.id as string);
    expect(remaining).toEqual([live]);
  });

  it("a style refuses its twenty-first reference", { timeout: 60_000 }, async () => {
    const { workspaceId } = harness;
    const payload = (styleId: string, id: string) =>
      JSON.stringify({
        id,
        storage_path: `${workspaceId}/styles/${styleId}/${id}.png`,
        mime_type: "image/png",
        byte_size: 8,
        width: 8,
        height: 8,
        content_hash: "a".repeat(64),
      });

    const full = await harness.createStyle("Guards capacity", { references: 20 });
    const blocked = crypto.randomUUID();
    await expect(harness.asMember("select public.add_style_reference($1, $2::jsonb)", [full.styleId, payload(full.styleId, blocked)])).rejects.toThrow(
      /TOO_MANY_REFERENCES/,
    );

    const room = await harness.createStyle("Guards capacity ok", { references: 19 });
    const accepted = crypto.randomUUID();
    const rows = await harness.asMember<{ id: string }>(
      "select (public.add_style_reference($1, $2::jsonb)).id as id",
      [room.styleId, payload(room.styleId, accepted)],
      { commit: true },
    );
    expect(rows[0].id).toBe(accepted);
    harness.track("reference", accepted);
  });
});

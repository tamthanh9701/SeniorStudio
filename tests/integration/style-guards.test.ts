// @vitest-environment node
// Database-level guarantees that no route test can see, because they live in the
// SQL functions: the hard delete's counts and predicate, the packet subset and
// library rules, enqueue/delete serialization, and the mask sweeper.
//
// Skipped unless RUN_DB_INTEGRATION=1 and TEST_DATABASE_URL are set, so the normal
// unit run never needs a database. The suite borrows an existing workspace and
// member (a member row is unique per auth user and jobs need a real auth user) and
// removes every row it creates, so it is safe against a shared database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

const requested = process.env.RUN_DB_INTEGRATION === "1";
const suite = requested ? describe : describe.skip;

const connectionString = process.env.TEST_DATABASE_URL ?? "";
const ca = process.env.STAGING_DB_CA;
const ssl = ca?.trim() ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };

let admin: Client;
let workspaceId: string;
let userId: string;
/** Everything the fixture creates, so cleanup never touches borrowed rows. */
const createdStyleIds = new Set<string>();
const createdMaskIds: string[] = [];
const createdJobIds: string[] = [];
const createdReferences: string[] = [];

type Row = Record<string, unknown>;

/** Runs one statement as the fixture member; commits only when asked to. */
async function asMember<T = Row>(sql: string, params: unknown[], options: { commit?: boolean } = {}): Promise<T[]> {
  await admin.query("begin");
  await admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: userId })]);
  try {
    const result = await admin.query(sql, params);
    await admin.query(options.commit ? "commit" : "rollback");
    return result.rows as T[];
  } catch (error) {
    await admin.query("rollback").catch(() => undefined);
    throw error;
  }
}

/** Runs a statement with the service-role claim, which some RPCs require. */
async function asService(sql: string, params: unknown[], options: { commit?: boolean } = {}): Promise<Row[]> {
  await admin.query("begin");
  await admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
  try {
    const result = await admin.query(sql, params);
    await admin.query(options.commit ? "commit" : "rollback");
    return result.rows as Row[];
  } catch (error) {
    await admin.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function createStyle(name: string, options: { references?: number; jobStatuses?: string[] } = {}) {
  const styleId = crypto.randomUUID();
  createdStyleIds.add(styleId);
  await admin.query("insert into public.styles(id, workspace_id, name, status) values($1,$2,$3,'active')", [styleId, workspaceId, name]);
  const references: Array<{ id: string; hash: string }> = [];
  for (let index = 0; index < (options.references ?? 1); index += 1) {
    const id = crypto.randomUUID();
    const hash = `${index}`.padStart(64, "a");
    await admin.query(
      "insert into public.style_references(id, style_id, storage_path, mime_type, byte_size, width, height, content_hash) values($1,$2,$3,'image/png',8,8,8,$4)",
      [id, styleId, `${workspaceId}/styles/${styleId}/${id}.png`, hash],
    );
    references.push({ id, hash });
    createdReferences.push(id);
  }
  // A confirmed definition is the authority every packet is checked against.
  await admin.query("begin");
  await admin.query("select set_config('app.style_definition_write', 'on', true)");
  const revision = crypto.randomUUID();
  await admin.query("update public.styles set confirmed_definition=$1::jsonb where id=$2", [
    JSON.stringify({ definition_version: 1, style_revision: revision, schema_snapshot: {}, reference_snapshot: references.map((reference) => ({ id: reference.id, content_hash: reference.hash })), confirmed_at: new Date().toISOString() }),
    styleId,
  ]);
  await admin.query("commit");

  for (const status of options.jobStatuses ?? []) {
    const inserted = await admin.query(
      `insert into public.ai_jobs(workspace_id, module, requested_by, operation, provider, model, status, input, style_id, output, lease_owner, lease_expires_at)
       values($1,'style',$2,'text_to_image','openai','openai/gpt-image-2',$3,$4::jsonb,$5,'{}'::jsonb,$6,$7) returning id`,
      [workspaceId, userId, status, JSON.stringify({ prompt: "fixture", count: 1, size: "1024x1024", quality: "low", style_id: styleId, original_prompt: "fixture", reference_ids: [] }), styleId, status === "processing" ? "test-hold" : null, status === "processing" ? new Date(Date.now() + 3600_000).toISOString() : null],
    );
    createdJobIds.push(inserted.rows[0].id as string);
  }
  return { styleId, references, revision };
}

function packet(styleId: string, revision: string, references: Array<{ id: string; hash: string }>, libraryReferenceIds?: string[]) {
  return JSON.stringify({
    packet_version: 1,
    style_id: styleId,
    style_revision: revision,
    operation: "text_to_image",
    model: "openai/gpt-image-2",
    original_prompt: "integration",
    compiled_prompt: "integration",
    reference_snapshot: references.map((reference) => ({ id: reference.id, content_hash: reference.hash })),
    schema_snapshot: {},
    count: 1,
    size: "1024x1024",
    quality: "low",
    ...(libraryReferenceIds ? { metadata: { library_reference_ids: libraryReferenceIds } } : {}),
  });
}

// The RPC returns a composite row, which pg hands back as raw text unless the
// fields are selected individually.
const enqueueSql =
  `select j.input as input, j.style_generation as style_generation, j.status as status
     from public.enqueue_style_group_job($1,$2,'text_to_image','openai/gpt-image-2',$3::jsonb,null) j`;

suite("style guards (database)", () => {
  beforeAll(async () => {
    if (!connectionString) throw new Error("RUN_DB_INTEGRATION=1 requires TEST_DATABASE_URL");
    admin = new Client({ connectionString, ssl });
    await admin.connect();
    const member = (await admin.query(
      `select wm.workspace_id, wm.supabase_user_id
         from public.workspace_members wm
         join auth.users u on u.id = wm.supabase_user_id
        order by wm.created_at
        limit 1`,
    )).rows[0] as { workspace_id: string; supabase_user_id: string } | undefined;
    if (!member) throw new Error("the integration database has no workspace member to run as");
    workspaceId = member.workspace_id;
    userId = member.supabase_user_id;
    await admin.query("insert into public.workspace_ai_limits(workspace_id, image_limit, brain_limit) values($1, 5000, 5000) on conflict (workspace_id) do nothing", [workspaceId]);
  });

  afterAll(async () => {
    if (!admin) return;
    const styles = [...createdStyleIds];
    // Order follows the foreign keys: job inputs and jobs first, then the assets
    // and references, then the styles they hang off.
    if (createdMaskIds.length > 0) await admin.query("delete from public.ai_job_inputs where id = any($1::uuid[])", [createdMaskIds]);
    if (createdJobIds.length > 0) await admin.query("delete from public.ai_jobs where id = any($1::uuid[])", [createdJobIds]);
    if (styles.length > 0) {
      await admin.query("delete from public.ai_job_inputs where style_id = any($1::uuid[])", [styles]);
      await admin.query("delete from public.ai_jobs where style_id = any($1::uuid[])", [styles]);
      await admin.query("delete from public.assets where style_id = any($1::uuid[])", [styles]);
      await admin.query("delete from public.style_references where style_id = any($1::uuid[])", [styles]);
      await admin.query("delete from public.styles where id = any($1::uuid[])", [styles]);
    }
    await admin.end();
  });

  it("enqueues a plain packet for a confirmed style", async () => {
    const style = await createStyle("Guards enqueue", { references: 1 });
    const rows = await asMember<{ input: { reference_ids: string[] }; status: string }>(enqueueSql, [style.styleId, userId, packet(style.styleId, style.revision, style.references)], { commit: false });
    expect(rows[0].status).toBe("queued");
    expect(rows[0].input.reference_ids).toEqual([style.references[0].id]);
  });

  it("hard-deletes a style with terminal jobs and reports its own objects", async () => {
    const style = await createStyle("Guards delete", { references: 1, jobStatuses: ["succeeded", "failed", "canceled"] });
    const assetId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const versionPath = `${workspaceId}/styles/${style.styleId}/outputs/${assetId}/${versionId}/source.png`;
    await admin.query("insert into public.assets(id, style_id, name, kind) values($1,$2,'guards asset','generated')", [assetId, style.styleId]);
    await admin.query(
      "insert into public.asset_versions(id, asset_id, source, storage_path, mime_type, width, height, byte_size) values($1,$2,'web_openai',$3,'image/png',8,8,8)",
      [versionId, assetId, versionPath],
    );
    const rows = await asMember<{ result: { images: number; references: number; jobs: number; storage_paths: string[] } }>(
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

  it("refuses a style that is still generating, and one that does not exist", async () => {
    const style = await createStyle("Guards busy", { references: 1, jobStatuses: ["processing"] });
    await expect(asMember("select public.delete_style_hard($1)", [style.styleId])).rejects.toThrow(/STYLE_BUSY/);
    await expect(asMember("select public.delete_style_hard($1)", [crypto.randomUUID()])).rejects.toThrow(/STYLE_NOT_FOUND/);
  });

  it("accepts a borrowed reference from the same library and records it", async () => {
    const libraryId = crypto.randomUUID();
    await admin.query("insert into public.style_libraries(id, workspace_id, name) values($1,$2,'Guards library')", [libraryId, workspaceId]);
    const lender = await createStyle("Guards lender", { references: 1 });
    const borrower = await createStyle("Guards borrower", { references: 1 });
    await admin.query("update public.styles set library_id=$1 where id=any($2::uuid[])", [libraryId, [lender.styleId, borrower.styleId]]);
    const rows = await asMember<{ input: { reference_ids: string[] }; style_generation: { metadata?: { library_reference_ids?: string[] } } }>(enqueueSql, [
      borrower.styleId,
      userId,
      packet(borrower.styleId, borrower.revision, [...borrower.references, ...lender.references], [lender.references[0].id]),
    ]);
    expect(rows[0].input.reference_ids).toEqual([borrower.references[0].id, lender.references[0].id]);
    expect(rows[0].style_generation.metadata?.library_reference_ids).toEqual([lender.references[0].id]);
  });

  it("refuses a borrowed reference from another workspace", async () => {
    const otherWorkspace = crypto.randomUUID();
    const otherLibrary = crypto.randomUUID();
    const otherStyle = crypto.randomUUID();
    const otherRef = crypto.randomUUID();
    await admin.query("insert into public.workspaces(id, name) values($1,'Guards foreign')", [otherWorkspace]);
    await admin.query("insert into public.style_libraries(id, workspace_id, name) values($1,$2,'Guards foreign library')", [otherLibrary, otherWorkspace]);
    await admin.query("insert into public.styles(id, workspace_id, name, status, library_id) values($1,$2,'Guards foreign style','active',$3)", [otherStyle, otherWorkspace, otherLibrary]);
    await admin.query(
      "insert into public.style_references(id, style_id, storage_path, mime_type, byte_size, width, height, content_hash) values($1,$2,$3,'image/png',8,8,8,$4)",
      [otherRef, otherStyle, `${otherWorkspace}/styles/${otherStyle}/${otherRef}.png`, "f".repeat(64)],
    );
    // The borrower claims the foreign library (library_id is member-writable) and
    // asks to borrow its reference.
    const borrower = await createStyle("Guards thief", { references: 1 });
    await admin.query("update public.styles set library_id=$1 where id=$2", [otherLibrary, borrower.styleId]);
    await expect(
      asMember(enqueueSql, [borrower.styleId, userId, packet(borrower.styleId, borrower.revision, borrower.references, [otherRef])]),
    ).rejects.toThrow(/REFERENCE_NOT_FOUND/);
    await admin.query("delete from public.ai_jobs where style_id=$1", [otherStyle]);
    await admin.query("delete from public.style_references where style_id=$1", [otherStyle]);
    await admin.query("delete from public.styles where id=$1", [otherStyle]);
    await admin.query("delete from public.style_libraries where id=$1", [otherLibrary]);
    await admin.query("delete from public.workspaces where id=$1", [otherWorkspace]);
  });

  it("accepts a subset of the confirmed snapshot", async () => {
    const style = await createStyle("Guards subset", { references: 3 });
    const rows = await asMember<{ input: { reference_ids: string[] } }>(enqueueSql, [
      style.styleId,
      userId,
      packet(style.styleId, style.revision, style.references.slice(0, 2)),
    ]);
    expect(rows[0].input.reference_ids).toEqual([style.references[0].id, style.references[1].id]);
  });

  it("serialises an enqueue against the hard delete", { timeout: 60_000 }, async () => {
    const style = await createStyle("Guards race", { references: 1 });
    const second = new Client({ connectionString, ssl });
    await second.connect();
    try {
      await admin.query("begin");
      await admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: userId })]);
      await admin.query("select public.delete_style_hard($1)", [style.styleId]);

      await second.query("begin");
      await second.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: userId })]);
      const pending = second
        .query(enqueueSql, [style.styleId, userId, packet(style.styleId, style.revision, style.references)])
        .then(() => "completed", (error: Error) => `rejected: ${error.message}`);

      // The server reports the wait, so it is observed rather than assumed. The
      // session is found by its statement: a transaction-mode pooler does not keep
      // per-client startup parameters such as application_name.
      let waiting = false;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !waiting) {
        const waitState = await admin.query(
          `select count(*)::int as waiting
             from pg_stat_activity
            where wait_event_type = 'Lock' and pid <> pg_backend_pid()
              and query like '%enqueue_style_group_job%'`,
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

  it("claims expired and terminal-job masks but leaves live ones", async () => {
    const style = await createStyle("Guards masks", { references: 1 });
    const mask = async (expiresIn: string, jobId: string | null) => {
      const id = crypto.randomUUID();
      await admin.query(
        `insert into public.ai_job_inputs(id, workspace_id, project_id, style_id, asset_id, parent_version_id, kind, storage_path, mime_type, width, height, byte_size, expires_at, job_id)
         values($1,$2,null,$3,null,null,'mask',$4,'image/png',8,8,8, now() + ($5)::interval, $6)`,
        [id, workspaceId, style.styleId, `${workspaceId}/styles/${style.styleId}/job-inputs/${id}/mask.png`, expiresIn, jobId],
      );
      createdMaskIds.push(id);
      return id;
    };
    const terminalJobId = crypto.randomUUID();
    await admin.query(
      `insert into public.ai_jobs(id, workspace_id, module, requested_by, operation, provider, model, status, input, style_id, output, completed_at)
       values($1,$2,'style',$3,'inpaint','openai','openai/gpt-image-2','failed',$4::jsonb,$5,'{}'::jsonb, now())`,
      [terminalJobId, workspaceId, userId, JSON.stringify({ prompt: "fixture", count: 1, size: "1024x1024", quality: "low", style_id: style.styleId, original_prompt: "fixture", reference_ids: [] }), style.styleId],
    );
    createdJobIds.push(terminalJobId);
    const abandoned = await mask("-2 hours", null);
    const attached = await mask("1 hour", terminalJobId);
    const live = await mask("1 hour", null);

    const claimed = (await asService("select id from public.claim_expired_job_masks(50)", [], { commit: true })).map((row) => row.id as string);
    expect(claimed).toEqual(expect.arrayContaining([abandoned, attached]));
    expect(claimed).not.toContain(live);
    const remaining = (await admin.query("select id from public.ai_job_inputs where id = any($1::uuid[])", [[abandoned, attached, live]])).rows.map((row) => row.id as string);
    expect(remaining).toEqual([live]);
  });
});

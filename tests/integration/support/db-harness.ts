// Shared fixture for the database integration suites. This is not a suite itself:
// vitest.config.ts collects only tests/**/*.test.ts(x).
//
// Skipped unless RUN_DB_INTEGRATION=1 and TEST_DATABASE_URL are set, so the normal
// unit run never needs a database. The harness borrows an existing workspace and
// member (a member row is unique per auth user and jobs need a real auth user) and
// removes every row it creates, so it is safe against a shared database.
import { describe } from "vitest";
import { Client } from "pg";

export const dbRequested = process.env.RUN_DB_INTEGRATION === "1";
export const dbSuite = dbRequested ? describe : describe.skip;

const connectionString = process.env.TEST_DATABASE_URL ?? "";
const ca = process.env.STAGING_DB_CA;
const ssl = ca?.trim() ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };

export type Row = Record<string, unknown>;

export type Harness = {
  admin: Client;
  workspaceId: string;
  userId: string;
  /** An independent connection for races; the caller closes it. */
  newSession(): Promise<Client>;
  /** Runs one statement as the fixture member; commits only when asked to. */
  asMember<T = Row>(sql: string, params: unknown[], options?: { commit?: boolean; as?: string }): Promise<T[]>;
  /** Runs a statement with the service-role claim, which some RPCs require. */
  asService<T = Row>(sql: string, params: unknown[], options?: { commit?: boolean }): Promise<T[]>;
  /** The enqueue call, for a suite that must run it on a connection of its own. */
  enqueueSql: string;
  /**
   * Today's image usage for a workspace (the borrowed one by default), the row and
   * day key reserve_ai_quota_internal accounts against; zeroes when there is none.
   */
  usage(workspaceId?: string): Promise<{ held: number; charged: number }>;
  createStyle(name: string, options?: { references?: number; jobStatuses?: string[]; workspaceId?: string }): Promise<{ styleId: string; references: Array<{ id: string; hash: string }>; revision: string }>;
  packet(styleId: string, revision: string, references: Array<{ id: string; hash: string }>, libraryReferenceIds?: string[]): string;
  /**
   * Rolled back unless `commit` is asked for: a committed queued job is claimable
   * by the production worker every five seconds, which would spend provider credit
   * on a fixture.
   */
  enqueueStyleJob(packetJson: string, styleId: string, options?: { commit?: boolean; as?: string }): Promise<{ id: string; input: Record<string, unknown>; style_generation: Record<string, unknown>; status: string }>;
  /**
   * A throwaway workspace owned by a throwaway auth user, for quota limits that
   * must not touch the borrowed workspace. `userId` must be passed to `asMember`
   * for anything the member gate checks.
   */
  createWorkspace(name: string): Promise<{ workspaceId: string; userId: string }>;
  track(kind: "style" | "job" | "mask" | "reference" | "library" | "workspace" | "user", id: string): void;
  cleanup(): Promise<void>;
};

export async function connectHarness(): Promise<Harness> {
  if (!connectionString) throw new Error("RUN_DB_INTEGRATION=1 requires TEST_DATABASE_URL");
  const admin = new Client({ connectionString, ssl });
  await admin.connect();
  const member = (
    await admin.query(
      `select wm.workspace_id, wm.supabase_user_id
         from public.workspace_members wm
         join auth.users u on u.id = wm.supabase_user_id
        order by wm.created_at
        limit 1`,
    )
  ).rows[0] as { workspace_id: string; supabase_user_id: string } | undefined;
  if (!member) throw new Error("the integration database has no workspace member to run as");
  const workspaceId = member.workspace_id;
  const userId = member.supabase_user_id;
  await admin.query("insert into public.workspace_ai_limits(workspace_id, image_limit, brain_limit) values($1, 5000, 5000) on conflict (workspace_id) do nothing", [workspaceId]);

  /** Everything the fixture creates, so cleanup never touches borrowed rows. */
  const created = {
    styles: new Set<string>(),
    masks: [] as string[],
    jobs: [] as string[],
    references: [] as string[],
    libraries: [] as string[],
    workspaces: [] as string[],
    users: [] as string[],
  };

  /** Runs one statement under a request claim; commits only when asked to. */
  async function asRole<T>(role: string, sub: string | null, sql: string, params: unknown[], options: { commit?: boolean } = {}): Promise<T[]> {
    await admin.query("begin");
    await admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(sub ? { role, sub } : { role })]);
    try {
      const result = await admin.query(sql, params);
      await admin.query(options.commit ? "commit" : "rollback");
      return result.rows as T[];
    } catch (error) {
      await admin.query("rollback").catch(() => undefined);
      throw error;
    }
  }

  const asMember = <T = Row>(sql: string, params: unknown[], options: { commit?: boolean; as?: string } = {}) =>
    asRole<T>("authenticated", options.as ?? userId, sql, params, options);

  const asService = <T = Row>(sql: string, params: unknown[], options: { commit?: boolean } = {}) =>
    asRole<T>("service_role", null, sql, params, options);

  const track: Harness["track"] = (kind, id) => {
    if (kind === "style") created.styles.add(id);
    else if (kind === "job") created.jobs.push(id);
    else if (kind === "mask") created.masks.push(id);
    else if (kind === "reference") created.references.push(id);
    else if (kind === "library") created.libraries.push(id);
    else if (kind === "workspace") created.workspaces.push(id);
    else created.users.push(id);
  };

  async function createStyle(name: string, options: { references?: number; jobStatuses?: string[]; workspaceId?: string } = {}) {
    const owner = options.workspaceId ?? workspaceId;
    const styleId = crypto.randomUUID();
    created.styles.add(styleId);
    await admin.query("insert into public.styles(id, workspace_id, name, status) values($1,$2,$3,'active')", [styleId, owner, name]);
    const references: Array<{ id: string; hash: string }> = [];
    for (let index = 0; index < (options.references ?? 1); index += 1) {
      const id = crypto.randomUUID();
      const hash = `${index}`.padStart(64, "a");
      await admin.query(
        "insert into public.style_references(id, style_id, storage_path, mime_type, byte_size, width, height, content_hash) values($1,$2,$3,'image/png',8,8,8,$4)",
        [id, styleId, `${owner}/styles/${styleId}/${id}.png`, hash],
      );
      references.push({ id, hash });
      created.references.push(id);
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
        [owner, userId, status, JSON.stringify({ prompt: "fixture", count: 1, size: "1024x1024", quality: "low", style_id: styleId, original_prompt: "fixture", reference_ids: [] }), styleId, status === "processing" ? "test-hold" : null, status === "processing" ? new Date(Date.now() + 3600_000).toISOString() : null],
      );
      created.jobs.push(inserted.rows[0].id as string);
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
    `select j.id as id, j.input as input, j.style_generation as style_generation, j.status as status
       from public.enqueue_style_group_job($1,$2,'text_to_image','openai/gpt-image-2',$3::jsonb,null) j`;

  async function enqueueStyleJob(packetJson: string, styleId: string, options: { commit?: boolean; as?: string } = {}) {
    const rows = await asMember<{ id: string; input: Record<string, unknown>; style_generation: Record<string, unknown>; status: string }>(
      enqueueSql,
      [styleId, options.as ?? userId, packetJson],
      options,
    );
    if (rows[0]?.id) created.jobs.push(rows[0].id);
    return rows[0];
  }

  async function createWorkspace(name: string) {
    const user = crypto.randomUUID();
    created.users.push(user);
    // workspace_members.supabase_user_id is UNIQUE, so the borrowed member cannot join a
    // second workspace: the workspace needs its own auth user, and since 0054
    // public.handle_new_user() gives that account its own workspace. The fixture uses
    // exactly that workspace - creating another one would leave the trigger's behind.
    await admin.query(
      `insert into auth.users(id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,'',now(),'{}'::jsonb,'{}'::jsonb,now(),now())`,
      [user, `probe+${user}@integration.test`],
    );
    const member = (await admin.query("select workspace_id from public.workspace_members where supabase_user_id = $1", [user])).rows[0] as { workspace_id: string } | undefined;
    if (!member) throw new Error("handle_new_user() did not create a workspace for the fixture account");
    const workspace = member.workspace_id;
    created.workspaces.push(workspace);
    await admin.query("update public.workspaces set name = $1 where id = $2", [name, workspace]);
    await admin.query("insert into public.workspace_ai_limits(workspace_id, image_limit, brain_limit) values($1, 100, 200) on conflict (workspace_id) do nothing", [workspace]);
    return { workspaceId: workspace, userId: user };
  }

  /** The usage row reserve_ai_quota_internal accounts against: today, UTC, image. */
  async function usage(targetWorkspace = workspaceId) {
    const rows = (
      await admin.query(
        "select held, charged from public.workspace_ai_usage where workspace_id = $1 and day = (now() at time zone 'utc')::date and route_group = 'image'",
        [targetWorkspace],
      )
    ).rows[0];
    return (rows ?? { held: 0, charged: 0 }) as { held: number; charged: number };
  }

  async function cleanup() {
    // A reservation whose job is about to be deleted must be released first: the
    // reservation row survives (FK is SET NULL) and a plain delete would leave
    // workspace_ai_usage.held holding units no reservation explains.
    await admin.query(
      "select public.release_ai_reservation_internal(r.id) from public.ai_quota_reservations r where r.job_id = any($1::uuid[]) and r.state = 'reserved'",
      [created.jobs],
    );
    const reservations = (await admin.query("select id from public.ai_quota_reservations where job_id = any($1::uuid[])", [created.jobs])).rows.map((row) => row.id as string);
    // Order follows the foreign keys: job inputs and jobs first, then the assets
    // and references, then the styles they hang off.
    await admin.query("delete from public.ai_job_inputs where id = any($1::uuid[])", [created.masks]);
    await admin.query("delete from public.ai_job_inputs where style_id = any($1::uuid[])", [[...created.styles]]);
    await admin.query("delete from public.ai_jobs where id = any($1::uuid[])", [created.jobs]);
    await admin.query("delete from public.ai_jobs where style_id = any($1::uuid[])", [[...created.styles]]);
    await admin.query("delete from public.assets where style_id = any($1::uuid[])", [[...created.styles]]);
    await admin.query("delete from public.style_references where style_id = any($1::uuid[])", [[...created.styles]]);
    await admin.query("delete from public.style_references where id = any($1::uuid[])", [created.references]);
    await admin.query("delete from public.styles where id = any($1::uuid[])", [[...created.styles]]);
    await admin.query("delete from public.style_libraries where id = any($1::uuid[])", [created.libraries]);
    await admin.query("delete from public.ai_quota_reservations where id = any($1::uuid[])", [reservations]);
    // Throwaway users first: if createWorkspace failed halfway, the member row is
    // still parked in the borrowed workspace and the workspace cascade misses it.
    await admin.query("delete from public.workspace_members where supabase_user_id = any($1::uuid[])", [created.users]);
    await admin.query("delete from public.workspaces where id = any($1::uuid[])", [created.workspaces]);
    await admin.query("delete from auth.users where id = any($1::uuid[])", [created.users]);
    await admin.end();
  }

  return {
    admin,
    workspaceId,
    userId,
    newSession: async () => {
      const session = new Client({ connectionString, ssl });
      await session.connect();
      return session;
    },
    asMember,
    asService,
    enqueueSql,
    usage,
    createStyle,
    packet,
    enqueueStyleJob,
    createWorkspace,
    track,
    cleanup,
  };
}

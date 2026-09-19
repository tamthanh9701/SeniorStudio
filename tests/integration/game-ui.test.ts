// @vitest-environment node
// Game UI guarantees that live in SQL: the version 2 authority, screen and
// element-map CAS, request idempotency, render creation on completion, the
// transparency rule for element outputs, workspace isolation and ordered cleanup.
//
// Runs only with RUN_DB_INTEGRATION=1 and TEST_DATABASE_URL, like the other
// database suites; every row it creates is removed afterwards.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { connectHarness, dbSuite, type Harness } from "./support/db-harness";

let harness: Harness;

const SCHEMA = {
  schema_version: 1,
  domain: "game_ui",
  name: "Integration HUD",
  visual_language: "Painted gold chrome over dark slate",
  palette: [{ id: "gold", role: "accent", color: "#d4a24a", notes: "bevel" }],
  typography: [{ role: "button", family_description: "serif", weight: "bold", casing: "uppercase", effects: "glow" }],
  layout: { density: "balanced", spacing_rules: "", alignment_rules: "", safe_area_rules: "", hierarchy_rules: "" },
  shape: { corner_rules: "bevel", border_rules: "", silhouette_rules: "" },
  surface: { materials: "brushed gold", shading: "", shadows: "", highlights: "" },
  iconography: { construction: "solid glyph", stroke_rules: "", detail_level: "" },
  components: [{ kind: "button", appearance: "gold frame", text_rules: "", composition_rules: "" }],
  invariants: ["gold bevel on every frame"],
  avoid: [],
  uncertainties: [],
};

const ELEMENT_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const REQUIREMENT_ID = "bbbbbbbb-1111-4111-8111-111111111111";

function spec() {
  return {
    schema_version: 1,
    name: "Battle HUD",
    description: "Top bar with the health bar",
    layout_notes: "",
    requirements: [
      { id: REQUIREMENT_ID, kind: "button", custom_type: null, name: "Continue", purpose: "", visible_text: "Continue", visible_state: null, required: true },
    ],
  };
}

function document(renderId: string, sourceVersionId: string) {
  return {
    schema_version: 1,
    render_id: renderId,
    source_version_id: sourceVersionId,
    canvas: { width: 64, height: 48 },
    elements: [
      {
        id: ELEMENT_ID,
        parent_id: null,
        kind: "button",
        custom_type: null,
        name: "Continue",
        purpose: "",
        visible_text: "Continue",
        visible_state: null,
        bounds: { x: 4, y: 4, width: 20, height: 12 },
        z_index: 0,
        occluded: false,
        confidence: 0.9,
        notes: "",
        reviewed: true,
      },
    ],
    coverage: [{ requirement_id: REQUIREMENT_ID, element_ids: [ELEMENT_ID], status: "present", note: "" }],
  };
}

/** A Game UI style with one reference, confirmed into definition version 2. */
async function createGameUiStyle(name: string) {
  const styleId = randomUUID();
  const referenceId = randomUUID();
  const hash = randomUUID().replace(/-/g, "").padEnd(64, "0").slice(0, 64);
  harness.track("style", styleId);
  harness.track("reference", referenceId);
  await harness.admin.query(
    `insert into public.styles(id, workspace_id, name, status, domain, schema, fingerprint, invariant_contract, analysis_meta, operability)
     values($1,$2,$3,'draft','game_ui',$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)`,
    [
      styleId,
      harness.workspaceId,
      name,
      JSON.stringify(SCHEMA),
      JSON.stringify({ domain: "game_ui", schema_version: 1, palette: SCHEMA.palette, shape: SCHEMA.shape, iconography: SCHEMA.iconography }),
      JSON.stringify({ domain: "game_ui", schema_version: 1, invariants: SCHEMA.invariants, avoid: SCHEMA.avoid }),
      JSON.stringify({ analyzedAt: new Date().toISOString(), reference_snapshot: [{ id: referenceId, content_hash: hash }], referenceCount: 1 }),
      JSON.stringify({ grade: "production_ready" }),
    ],
  );
  await harness.admin.query(
    `insert into public.style_references(id, style_id, storage_path, mime_type, byte_size, width, height, content_hash)
     values($1,$2,$3,'image/png',8,8,8,$4)`,
    [referenceId, styleId, `${harness.workspaceId}/styles/${styleId}/${referenceId}.png`, hash],
  );
  // The confirmed definition is written by the real RPC, so this also proves the
  // Game UI confirmation path rather than constructing the JSON by hand.
  // Text, not a Date: the column keeps microseconds and a JS Date round trip
  // would compare unequal to the stored value.
  const updatedAt = (await harness.admin.query("select updated_at::text as updated_at from public.styles where id = $1", [styleId])).rows[0].updated_at as string;
  await harness.asMember("select public.confirm_style_definition($1,$2::timestamptz)", [styleId, updatedAt], { commit: true });
  const confirmed = (await harness.admin.query("select confirmed_definition, status from public.styles where id = $1", [styleId])).rows[0] as { confirmed_definition: Record<string, unknown>; status: string };
  return { styleId, referenceId, hash, revision: confirmed.confirmed_definition.style_revision as string, status: confirmed.status };
}

function screenPacket(params: {
  styleId: string;
  revision: string;
  reference: { id: string; hash: string };
  screenId: string;
  draftRevision: number;
  requestId: string;
  model?: string;
}) {
  return {
    packet_version: 2,
    domain: "game_ui",
    style_id: params.styleId,
    style_revision: params.revision,
    schema_snapshot: SCHEMA,
    operation: "text_to_image",
    original_prompt: "Battle HUD screen",
    compiled_prompt: "STYLE ... SCREEN ...",
    reference_snapshot: [{ id: params.reference.id, content_hash: params.reference.hash }],
    source_version_id: null,
    model: params.model ?? "openai/gpt-image-2",
    size: "1024x1024",
    quality: "low",
    count: 1,
    intent: "screen",
    context: {
      screen_id: params.screenId,
      draft_revision: params.draftRevision,
      spec_snapshot: spec(),
      wireframe_input_id: null,
      source_content_hash: null,
      request_id: params.requestId,
    },
  };
}

beforeAll(async () => {
  harness = await connectHarness();
}, 60_000);

afterAll(async () => {
  // The connection may never have been established; there is nothing to clean then.
  if (harness) await harness.cleanup();
});

dbSuite("game ui (database)", () => {
  it("confirms as definition version 2 and refuses every legacy enqueue path", { timeout: 30_000 }, async () => {
    const fixture = await createGameUiStyle("Legacy path guard");
    expect(fixture.status).toBe("active");
    const definition = (await harness.admin.query("select confirmed_definition from public.styles where id = $1", [fixture.styleId])).rows[0].confirmed_definition as Record<string, unknown>;
    expect(definition.definition_version).toBe(2);
    expect(definition.domain).toBe("game_ui");
    expect((definition.schema_snapshot as Record<string, unknown>).domain).toBe("game_ui");

    const screen = await saveScreen(fixture, "Legacy path guard screen");
    const legacy = {
      packet_version: 1,
      style_id: fixture.styleId,
      style_revision: fixture.revision,
      operation: "text_to_image",
      model: "openai/gpt-image-2",
      original_prompt: "legacy",
      compiled_prompt: "legacy",
      reference_snapshot: [{ id: fixture.referenceId, content_hash: fixture.hash }],
      schema_snapshot: {},
      count: 1,
      size: "1024x1024",
      quality: "low",
    };
    await expect(
      harness.asMember("select public.enqueue_style_group_job($1,$2,'text_to_image','openai/gpt-image-2',$3::jsonb,null) j", [fixture.styleId, harness.userId, JSON.stringify(legacy)], {
        commit: false,
      }),
    ).rejects.toThrow(/INVALID_PACKET/);
    // A direct insert is the other way in, and the trigger closes it.
    await expect(
      harness.admin.query(
        `insert into public.ai_jobs(workspace_id, module, requested_by, operation, provider, model, status, input, style_id)
         values($1,'style',$2,'text_to_image','openai','openai/gpt-image-2','queued',$3::jsonb,$4)`,
        [harness.workspaceId, harness.userId, JSON.stringify({ prompt: "x", count: 1, size: "1024x1024", quality: "low", style_id: fixture.styleId, original_prompt: "x", reference_ids: [] }), fixture.styleId],
      ),
    ).rejects.toThrow(/INVALID_PACKET/);
    expect(screen.draftRevision).toBe(1);
  });

  it("serialises screen revisions, then pays once for one request id", { timeout: 30_000 }, async () => {
    const fixture = await createGameUiStyle("Idempotent enqueue");
    const screen = await saveScreen(fixture, "Idempotency screen");
    // One revision at a time: the second save advances it, the third is stale.
    const advanced = await saveScreen(fixture, "Second write", 1, screen.id);
    expect(advanced.draftRevision).toBe(2);
    await expect(saveScreen(fixture, "Stale write", 1, screen.id)).rejects.toThrow(/SCREEN_VERSION_CONFLICT/);

    const requestId = randomUUID();
    const packet = screenPacket({ styleId: fixture.styleId, revision: fixture.revision, reference: { id: fixture.referenceId, hash: fixture.hash }, screenId: screen.id, draftRevision: advanced.draftRevision, requestId });
    const first = await harness.enqueueStyleJob(JSON.stringify(packet), fixture.styleId, { commit: true, guardFromClaim: true });
    expect(first.status).toBe("queued");
    const second = await harness.enqueueStyleJob(JSON.stringify(packet), fixture.styleId, { commit: true, guardFromClaim: true });
    expect(second.id).toBe(first.id);
    const reservations = await harness.admin.query("select count(*)::int as count from public.ai_quota_reservations where job_id = $1", [first.id]);
    expect(reservations.rows[0].count).toBe(1);
    // The same key with a different packet is a contradiction, not a retry.
    const conflicting = { ...packet, compiled_prompt: "STYLE ... SCREEN ... (edited)" };
    await expect(harness.enqueueStyleJob(JSON.stringify(conflicting), fixture.styleId, { commit: false })).rejects.toThrow(/CONFLICT/);
    // And a draft that moved on cannot be generated from a stale plan.
    const movedSpec = { ...spec(), description: "changed after the plan" };
    await harness.asMember("select public.save_game_ui_screen($1,$2,$3,$4,$5::jsonb,$6)", [fixture.styleId, screen.id, advanced.draftRevision, "Moved on", JSON.stringify(movedSpec), null], { commit: true });
    await expect(harness.enqueueStyleJob(JSON.stringify(packet), fixture.styleId, { commit: false })).rejects.toThrow(/SCREEN_VERSION_CONFLICT/);
  });

  it("keeps another workspace out of screens, renders and element maps", { timeout: 30_000 }, async () => {
    const fixture = await createGameUiStyle("Isolation");
    const screen = await saveScreen(fixture, "Isolation screen");
    const other = await createWorkspaceWithUser("Game UI intruder");
    // Row level security only filters a statement that runs as the authenticated
    // role: a superuser connection bypasses it whatever the claims say. The probe
    // therefore owns its session and its transaction.
    const session = await harness.newSession();
    try {
      await session.query("begin");
      await session.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: other.userId })]);
      await session.query("set local role authenticated");
      const reads = await session.query("select count(*)::int as screens from public.game_ui_screens");
      expect(reads.rows[0].screens).toBe(0);
      const renders = await session.query("select count(*)::int as renders from public.game_ui_renders");
      expect(renders.rows[0].renders).toBe(0);
    } finally {
      await session.query("rollback").catch(() => undefined);
      await session.end();
    }
    await expect(
      harness.asMember("select public.save_game_ui_screen($1,$2,$3,$4,$5::jsonb,$6)", [fixture.styleId, screen.id, screen.draftRevision, "Intruder", JSON.stringify(spec()), null], { as: other.userId, commit: false }),
    ).rejects.toThrow(/STYLE_NOT_FOUND/);
    await expect(
      harness.asMember("select public.save_game_ui_elements($1,0,$2::jsonb)", [randomUUID(), JSON.stringify(document(randomUUID(), randomUUID()))], { as: other.userId, commit: false }),
    ).rejects.toThrow(/RENDER_NOT_FOUND/);
  });

  it("creates one render per completed screen image and never duplicates it", { timeout: 30_000 }, async () => {
    const fixture = await createGameUiStyle("Render creation");
    const screen = await saveScreen(fixture, "Render screen");
    const jobId = await createPersistingJob(fixture, screen, randomUUID());
    const versionId = randomUUID();
    const assetId = randomUUID();
    const result = [
      {
        asset_id: assetId,
        version_id: versionId,
        storage_path: `${harness.workspaceId}/styles/${fixture.styleId}/outputs/${assetId}/${versionId}/source.png`,
        mime_type: "image/png",
        width: 64,
        height: 48,
        byte_size: 1024,
        name: "Screen 1",
        prompt: "Battle HUD screen",
        provider_response_id: "req-integration",
        metadata: { content_hash: "c".repeat(64) },
      },
    ];
    await harness.asService("select public.complete_ai_job_with_results($1,$2,$3,$4,$5::jsonb,$6::jsonb)", [jobId, "integration-worker", "req-integration", "completed", JSON.stringify(result), JSON.stringify({ results: result })], {
      commit: true,
    });
    const renders = await harness.admin.query("select id, asset_id, version_id, style_revision from public.game_ui_renders where job_id = $1", [jobId]);
    expect(renders.rowCount).toBe(1);
    expect(renders.rows[0].version_id).toBe(versionId);
    expect(renders.rows[0].style_revision).toBe(fixture.revision);
    // Re-running the same persistence must not add a second render.
    await harness.asService("update public.ai_jobs set status = 'persisting', lease_owner = 'integration-worker', lease_expires_at = now() + interval '5 minutes' where id = $1", [jobId], { commit: true });
    await harness
      .asService("select public.complete_ai_job_with_results($1,$2,$3,$4,$5::jsonb,$6::jsonb)", [jobId, "integration-worker", "req-integration", "completed", JSON.stringify(result), JSON.stringify({ results: result })], { commit: true })
      .catch(() => undefined);
    expect((await harness.admin.query("select count(*)::int as count from public.game_ui_renders where job_id = $1", [jobId])).rows[0].count).toBe(1);
  });

  it("records an element output only when the matte matches and the pixels are transparent", { timeout: 30_000 }, async () => {
    const fixture = await createGameUiStyle("Element outputs");
    const screen = await saveScreen(fixture, "Outputs screen");
    const jobId = await createPersistingJob(fixture, screen, randomUUID());
    const renderId = await completeScreenJob(fixture, jobId, 64, 48);
    const set = await saveElements(renderId, 0);
    const elementSetId = set.id as string;

    const matteId = randomUUID();
    await expect(
      registerInput(fixture, "element_matte", matteId, { width: 16, height: 16 }, { render_id: renderId, element_set_id: elementSetId, element_id: ELEMENT_ID }),
    ).rejects.toThrow(/INVALID_REQUEST/);
    await registerInput(fixture, "element_matte", matteId, { width: 20, height: 12 }, { render_id: renderId, element_set_id: elementSetId, element_id: ELEMENT_ID });

    const opaque = await commitExtraction(fixture, { renderId, elementSetId, matteId, alphaStatus: "opaque" });
    expect(opaque.alpha_status).toBe("opaque");
    await expect(
      harness.asMember("select public.review_game_ui_output($1,$2,$3)", [opaque.id, "pending", "accepted"], { commit: false }),
    ).rejects.toThrow(/TRANSPARENCY_REQUIRED/);
    await harness.asMember("select public.review_game_ui_output($1,$2,$3)", [opaque.id, "pending", "discarded"], { commit: true });
    // A decision cannot be replayed from a stale expectation.
    await expect(
      harness.asMember("select public.review_game_ui_output($1,$2,$3)", [opaque.id, "pending", "accepted"], { commit: false }),
    ).rejects.toThrow(/SCREEN_VERSION_CONFLICT/);

    const transparent = await commitExtraction(fixture, { renderId, elementSetId, matteId, alphaStatus: "transparent" });
    const accepted = await harness.asMember<{ review_status: string }>("select (public.review_game_ui_output($1,$2,$3)).review_status", [transparent.id, "pending", "accepted"], { commit: true });
    expect(accepted[0].review_status).toBe("accepted");
    // A committed version is not an orphan, so the upload sweep must not claim it.
    const swept = await harness.asService<{ committed: boolean }>("select committed from public.claim_expired_game_ui_uploads(50) where version_id = $1", [transparent.version_id]);
    expect(swept).toHaveLength(0);
  });

  it("refuses the delete while a job is queued and cleans every Game UI row afterwards", { timeout: 30_000 }, async () => {
    const fixture = await createGameUiStyle("Cleanup");
    const screen = await saveScreen(fixture, "Cleanup screen");
    const packet = screenPacket({ styleId: fixture.styleId, revision: fixture.revision, reference: { id: fixture.referenceId, hash: fixture.hash }, screenId: screen.id, draftRevision: screen.draftRevision, requestId: randomUUID() });
    const job = await harness.enqueueStyleJob(JSON.stringify(packet), fixture.styleId, { commit: true, guardFromClaim: true });
    await expect(harness.asMember("select public.delete_style_hard($1)", [fixture.styleId], { commit: false })).rejects.toThrow(/STYLE_BUSY/);

    await harness.admin.query("delete from public.ai_jobs where id = $1", [job.id]);
    const result = await harness.asMember<{ result: { screens: number; renders: number; jobs: number; storage_paths: string[] } }>("select public.delete_style_hard($1) as result", [fixture.styleId], { commit: true });
    expect(result[0].result.screens).toBe(1);
    // The queued job was removed above, so the delete reports no jobs; what it
    // reported before that removal was the STYLE_BUSY refusal.
    expect(result[0].result.jobs).toBe(0);
    const leftovers = await harness.admin.query(
      `select
         (select count(*)::int from public.game_ui_screens where style_id = $1) as screens,
         (select count(*)::int from public.game_ui_renders where style_id = $1) as renders,
         (select count(*)::int from public.game_ui_inputs where style_id = $1) as inputs`,
      [fixture.styleId],
    );
    expect(leftovers.rows[0]).toEqual({ screens: 0, renders: 0, inputs: 0 });
  });
});

async function saveScreen(fixture: { styleId: string; referenceId: string; hash: string; revision: string }, name: string, expectedRevision: number = 0, screenId: string = randomUUID()) {
  const rows = await harness.asMember<{ id: string; draft_revision: number }>(
    "select (s).id as id, (s).draft_revision::int as draft_revision from public.save_game_ui_screen($1,$2,$3,$4,$5::jsonb,$6) s",
    [fixture.styleId, screenId, expectedRevision, name, JSON.stringify(spec()), null],
    { commit: true },
  );
  return { id: rows[0].id, draftRevision: rows[0].draft_revision };
}

async function saveElements(renderId: string, expectedRevision: number, doc?: unknown) {
  const document_ = doc ?? document(renderId, await renderVersion(renderId));
  const rows = await harness.asMember<{ id: string; revision: number }>(
    "select (s).id as id, (s).revision::int as revision from public.save_game_ui_elements($1,$2,$3::jsonb) s",
    [renderId, expectedRevision, JSON.stringify(document_)],
    { commit: true },
  );
  return rows[0];
}

async function renderVersion(renderId: string): Promise<string> {
  return (await harness.admin.query("select version_id from public.game_ui_renders where id = $1", [renderId])).rows[0].version_id as string;
}

/** A job in `persisting` with a lease, exactly as the worker leaves it. */
async function createPersistingJob(fixture: { styleId: string; referenceId: string; hash: string; revision: string }, screen: { id: string; draftRevision: number }, requestId: string): Promise<string> {
  const packet = screenPacket({ styleId: fixture.styleId, revision: fixture.revision, reference: { id: fixture.referenceId, hash: fixture.hash }, screenId: screen.id, draftRevision: screen.draftRevision, requestId });
  const rows = await harness.admin.query(
    `insert into public.ai_jobs(workspace_id, module, requested_by, operation, provider, model, status, input, style_id, style_generation, lease_owner, lease_expires_at, request_id)
     values($1,'style',$2,'text_to_image','openai','openai/gpt-image-2','persisting',$3::jsonb,$4,$5::jsonb,'integration-worker', now() + interval '10 minutes', $6) returning id`,
    [harness.workspaceId, harness.userId, JSON.stringify({ prompt: "Battle HUD screen", count: 1, size: "1024x1024", quality: "low", style_id: fixture.styleId, original_prompt: "Battle HUD screen", reference_ids: [fixture.referenceId], game_ui: { intent: "screen", screen_id: screen.id } }), fixture.styleId, JSON.stringify(packet), requestId],
  );
  const jobId = rows.rows[0].id as string;
  harness.track("job", jobId);
  return jobId;
}

async function completeScreenJob(fixture: { styleId: string }, jobId: string, width: number, height: number): Promise<string> {
  const assetId = randomUUID();
  const versionId = randomUUID();
  const result = [
    {
      asset_id: assetId,
      version_id: versionId,
      storage_path: `${harness.workspaceId}/styles/${fixture.styleId}/outputs/${assetId}/${versionId}/source.png`,
      mime_type: "image/png",
      width,
      height,
      byte_size: 2048,
      name: "Screen",
      prompt: "Battle HUD screen",
      provider_response_id: "req-render",
      metadata: { content_hash: "d".repeat(64) },
    },
  ];
  await harness.asService("select public.complete_ai_job_with_results($1,$2,$3,$4,$5::jsonb,$6::jsonb)", [jobId, "integration-worker", "req-render", "completed", JSON.stringify(result), JSON.stringify({ results: result })], { commit: true });
  return (await harness.admin.query("select id from public.game_ui_renders where version_id = $1", [versionId])).rows[0].id as string;
}

async function registerInput(
  fixture: { styleId: string },
  kind: "wireframe" | "element_matte",
  inputId: string,
  size: { width: number; height: number },
  context: Record<string, string>,
) {
  const assetId = randomUUID();
  const versionId = randomUUID();
  const path = `${harness.workspaceId}/styles/${fixture.styleId}/sources/${assetId}/${versionId}/source.png`;
  const file = { storage_path: path, mime_type: "image/png", width: size.width, height: size.height, byte_size: 512, content_hash: "e".repeat(64), name: "fixture" };
  const rows = await harness.asService<{ id: string }>(
    "select (i).id as id from public.register_game_ui_input($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) i",
    [harness.workspaceId, fixture.styleId, assetId, versionId, inputId, kind, JSON.stringify(file), JSON.stringify(context)],
    { commit: true },
  );
  return { inputId: rows[0].id, versionId };
}

async function commitExtraction(
  fixture: { styleId: string },
  params: { renderId: string; elementSetId: string; matteId: string; alphaStatus: "transparent" | "opaque" },
) {
  const assetId = randomUUID();
  const versionId = randomUUID();
  const outputId = randomUUID();
  const path = `${harness.workspaceId}/styles/${fixture.styleId}/outputs/${assetId}/${versionId}/source.png`;
  const file = { storage_path: path, mime_type: "image/png", width: 20, height: 12, byte_size: 700, content_hash: "f".repeat(64), alpha_status: params.alphaStatus, name: "Continue" };
  const rows = await harness.asService<{ id: string; version_id: string; alpha_status: string }>(
    "select (o).id as id, (o).version_id as version_id, (o).alpha_status as alpha_status from public.commit_game_ui_extraction($1,$2,$3,$4,$5,$6,$7,$8::jsonb) o",
    [outputId, params.renderId, params.elementSetId, ELEMENT_ID, params.matteId, assetId, versionId, JSON.stringify(file)],
    { commit: true },
  );
  return rows[0];
}

/** A second workspace with its own member, without relying on signup triggers. */
async function createWorkspaceWithUser(name: string) {
  const workspaceId = randomUUID();
  const userId = randomUUID();
  harness.track("workspace", workspaceId);
  harness.track("user", userId);
  await harness.admin.query("insert into public.workspaces(id, name) values($1,$2)", [workspaceId, name]);
  // email is required on a member row; supabase_user_id is what authorization reads.
  await harness.admin.query(
    "insert into public.workspace_members(workspace_id, supabase_user_id, email) values($1,$2,$3)",
    [workspaceId, userId, `intruder+${userId}@integration.test`],
  );
  return { workspaceId, userId };
}

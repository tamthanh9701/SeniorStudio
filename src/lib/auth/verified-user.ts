/** The auth surface this needs; the server and browser clients both satisfy it. */
type ClaimsClient = {
  auth: {
    getClaims(): Promise<{ data: { claims?: unknown } | null; error?: unknown }>;
  };
};

/**
 * The authenticated caller, taken from verified JWT claims.
 *
 * `getClaims()` verifies the token locally against the project's JWKS once the
 * project signs with an asymmetric key, and falls back to the `getUser()` round trip
 * while the key is still symmetric - both paths return the same payload, so the
 * claims are the authority either way. `sub` is the user id and `email` is present
 * for every password/email identity.
 */
export async function getVerifiedUser(supabase: ClaimsClient): Promise<{ id: string; email: string | null } | null> {
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return null;
  const claims = data.claims as { sub?: unknown; email?: unknown };
  if (typeof claims.sub !== "string") return null;
  return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
}

import { jwtVerify, createRemoteJWKSet } from "jose";
import { requireAuth0Config } from "@/env";

export interface Auth0Claims {
  sub: string;
  email: string;
  email_verified: boolean;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  scope?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _jwks: any = null;

function getJWKS() {
  const config = requireAuth0Config();
  if (!config) throw new Error("Auth0 not configured");

  if (!_jwks) {
    const url = new URL(`${config.issuerBaseURL}/.well-known/jwks.json`);
    _jwks = createRemoteJWKSet(url);
  }
  return _jwks;
}

export async function verifyAuth0Token(token: string): Promise<Auth0Claims> {
  const config = requireAuth0Config();
  if (!config) throw new Error("Auth0 not configured");

  const JWKS = getJWKS();

  const { payload } = await jwtVerify(token, JWKS, {
    issuer: config.issuerBaseURL,
    audience: config.audience,
  });

  return {
    sub: payload.sub!,
    email: payload.email as string,
    email_verified: payload.email_verified as boolean,
    iss: payload.iss!,
    aud: payload.aud as string,
    exp: payload.exp!,
    iat: payload.iat!,
    scope: payload.scope as string | undefined,
  };
}

export function hasScope(claims: Auth0Claims, required: string): boolean {
  if (!claims.scope) return false;
  return claims.scope.split(" ").includes(required);
}

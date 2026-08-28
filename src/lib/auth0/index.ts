import {
  createRemoteJWKSet,
  jwtVerify,
  type RemoteJWKSet,
} from "jose";
import { requireAuth0Config } from "@/env";

export interface Auth0Claims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  scopes: string[];
  exp?: number;
  clientId: string;
}

let jwks: RemoteJWKSet | null = null;

function getIssuer(): string {
  const config = requireAuth0Config();
  if (!config) throw new Error("Auth0 not configured");
  return `${config.issuerBaseURL.replace(/\/+$/, "")}/`;
}

function getJwks(): RemoteJWKSet {
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(".well-known/jwks.json", getIssuer())
    );
  }
  return jwks;
}

export async function verifyAuth0Token(token: string): Promise<Auth0Claims> {
  const config = requireAuth0Config();
  if (!config) throw new Error("Auth0 not configured");

  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: getIssuer(),
    audience: config.audience,
  });

  if (!payload.sub) throw new Error("Missing Auth0 subject");

  const email = typeof payload.email === "string" ? payload.email : undefined;
  const emailVerified = payload.email_verified === true;
  const scopeValue =
    typeof payload.scope === "string"
      ? payload.scope
      : Array.isArray(payload.permissions)
        ? payload.permissions.filter(
            (permission): permission is string =>
              typeof permission === "string"
          ).join(" ")
        : "";

  return {
    sub: payload.sub,
    email,
    email_verified: emailVerified,
    scopes: scopeValue.split(" ").filter(Boolean),
    exp: payload.exp,
    clientId: typeof payload.azp === "string" ? payload.azp : "chatgpt",
  };
}

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

interface Auth0UserInfo {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
}

let jwks: RemoteJWKSet | null = null;

function getIssuer() {
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

async function getUserInfo(token: string): Promise<Auth0UserInfo> {
  const response = await fetch(new URL("userinfo", getIssuer()), {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (!response.ok) throw new Error("Auth0 UserInfo unavailable");
  return response.json() as Promise<Auth0UserInfo>;
}

export async function verifyAuth0Token(token: string): Promise<Auth0Claims> {
  const config = requireAuth0Config();
  if (!config) throw new Error("Auth0 not configured");

  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: getIssuer(),
    audience: config.audience,
  });

  if (!payload.sub) throw new Error("Missing Auth0 subject");

  const scopeValue =
    typeof payload.scope === "string"
      ? payload.scope
      : Array.isArray(payload.permissions)
        ? payload.permissions.filter(
            (permission): permission is string =>
              typeof permission === "string"
          ).join(" ")
        : "";

  let email =
    typeof payload.email === "string" ? payload.email : undefined;
  let emailVerified =
    typeof payload.email_verified === "boolean"
      ? payload.email_verified
      : undefined;

  if (!email || emailVerified !== true) {
    const userInfo = await getUserInfo(token);
    if (userInfo.sub !== payload.sub) {
      throw new Error("Auth0 UserInfo subject mismatch");
    }
    email =
      typeof userInfo.email === "string" ? userInfo.email : undefined;
    emailVerified = userInfo.email_verified === true;
  }

  return {
    sub: payload.sub,
    email,
    email_verified: emailVerified,
    scopes: scopeValue.split(" ").filter(Boolean),
    exp: payload.exp,
    clientId:
      typeof payload.azp === "string"
        ? payload.azp
        : typeof payload.client_id === "string"
          ? payload.client_id
          : "chatgpt",
  };
}

import { getEnv } from "@/env";

export interface Auth0Config {
  issuerBaseURL: string;
  audience: string;
}

export function getAuth0Config(): Auth0Config {
  const env = getEnv();
  return {
    issuerBaseURL: env.AUTH0_ISSUER_BASE_URL,
    audience: env.AUTH0_AUDIENCE,
  };
}

export async function verifyJwt(token: string): Promise<{ sub: string; email: string }> {
  const config = getAuth0Config();
  
  // In production, you would verify the JWT against Auth0's JWKS
  // For now, we'll decode the payload (simplified for MVP)
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid token format");
  }
  
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    
    if (payload.iss !== config.issuerBaseURL) {
      throw new Error("Invalid issuer");
    }
    
    if (payload.aud !== config.audience) {
      throw new Error("Invalid audience");
    }
    
    if (payload.exp && payload.exp < Date.now() / 1000) {
      throw new Error("Token expired");
    }
    
    return {
      sub: payload.sub,
      email: payload.email,
    };
  } catch {
    throw new Error("Invalid token");
  }
}

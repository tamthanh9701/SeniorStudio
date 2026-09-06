import { getEnv } from "@/env";

export function styleProfilesEnabled(): boolean {
  return getEnv().STYLE_PROFILES_ENABLED;
}

// Loads the seller's profile (app_settings key 'profile'), filled from the defaults in profile.ts.
import { adminClient } from "./supabase.ts";
import { normalizeProfile, profileReady, type SellerProfile } from "./profile.ts";

export async function loadProfile(): Promise<SellerProfile> {
  const { data } = await adminClient().from("app_settings").select("value").eq("key", "profile").maybeSingle();
  return normalizeProfile(data?.value ?? null);
}

/** True once Admin > Setup is finished (app_settings 'onboarding') and the saved profile can carry research. Research,
    the weekly build and email drafts wait until then. */
export async function setupDone(): Promise<boolean> {
  const { data } = await adminClient().from("app_settings").select("value").eq("key", "onboarding").maybeSingle();
  // deno-lint-ignore no-explicit-any
  if (!(data?.value as any)?.completed_at) return false;
  return profileReady(await loadProfile());
}

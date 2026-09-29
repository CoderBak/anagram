// lib/webengine/tierStore.ts — the tier choice in the extension's storage (lib/webengine/tier.ts).
// Background and pages only: the offscreen document has no storage, and reads its address.
import { storage } from "#imports";
import type { TierChoice } from "./tier";

export const engineTierChoice = storage.defineItem<TierChoice | null>("local:engineTier", { fallback: null });

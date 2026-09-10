// Shared provider-list shaping for the Usage → Details panel.
//
// Request history is keyed by provider id. A configured node keeps its id
// forever, but a node deleted later still has history rows pointing at an id
// that resolves to nothing ("openai-compatible-chat-<uuid>"), and built-in
// providers are referenced by alias or id. This module turns that raw id list
// into the dropdown's entries.
import { getProviderNodes } from "@/lib/localDb";
import {
  AI_PROVIDERS,
  getProviderByAlias,
  DELETED_PROVIDER_ID,
  DELETED_PROVIDER_LABEL,
} from "@/shared/constants/providers";

/**
 * id → display name for every provider that still resolves: a configured node
 * of any type, else a built-in provider referenced by alias or id (nodes win,
 * matching the original per-id lookup order).
 */
export async function getProviderNameMap() {
  const map = {};
  for (const node of await getProviderNodes()) {
    if (node?.id) map[node.id] = node.name;
  }
  for (const providerId of Object.keys(AI_PROVIDERS)) {
    for (const key of [providerId, AI_PROVIDERS[providerId]?.alias]) {
      if (!key || map[key]) continue;
      const name = (getProviderByAlias(key) || AI_PROVIDERS[providerId])?.name;
      if (name) map[key] = name;
    }
  }
  return map;
}

/**
 * Fold raw provider ids into dropdown entries. Resolvable ids keep their name;
 * every unresolvable id collapses into a single DELETED_PROVIDER entry, placed
 * first so it is easy to spot.
 *
 * @param {string[]} providerIds
 * @param {Record<string, string>} nameMap - from getProviderNameMap()
 * @returns {{ id: string, name: string }[]}
 */
export function buildProviderEntries(providerIds, nameMap) {
  const entries = [];
  let orphaned = false;
  for (const id of providerIds || []) {
    if (!id) continue;
    if (nameMap?.[id]) entries.push({ id, name: nameMap[id] });
    else orphaned = true;
  }
  if (orphaned) entries.unshift({ id: DELETED_PROVIDER_ID, name: DELETED_PROVIDER_LABEL });
  return entries;
}

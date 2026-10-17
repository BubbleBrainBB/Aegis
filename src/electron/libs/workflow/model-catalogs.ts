// Live model catalogs for workflow members (plan §3.2). The Planner may only
// pin a model the agent itself offers, so each catalog comes from the same
// source as that agent's composer picker — never a list kept in app code.

export type ModelOption = { id: string; label?: string };

type CatalogEntry = {
  id?: unknown;
  name?: unknown;
  value?: unknown;
  label?: unknown;
  displayName?: unknown;
  enabled?: unknown;
  isEnabled?: unknown;
};

/**
 * Model ids and display names from any provider's model config shape. Models
 * the user hid from the composer picker are left out, as they are there.
 */
export function catalogOptions(config: unknown): ModelOption[] {
  if (!config || typeof config !== 'object') return [];
  const record = config as { options?: unknown; availableModels?: unknown; models?: unknown };
  const detailed = [record.availableModels, record.models].find(Array.isArray) as CatalogEntry[] | undefined;
  const options = new Map<string, ModelOption>();
  for (const entry of detailed ?? []) {
    const id = [entry?.id, entry?.name, entry?.value].find((v): v is string => typeof v === 'string' && v.trim() !== '');
    if (!id || options.has(id) || entry.enabled === false || entry.isEnabled === false) continue;
    // DeepSeek pairs an `id` with a display `name`; elsewhere `name` is the id.
    const label = [entry.label, entry.displayName, entry.id !== undefined ? entry.name : undefined]
      .find((v): v is string => typeof v === 'string' && v.trim() !== '');
    options.set(id, label && label !== id ? { id, label } : { id });
  }
  if (!detailed?.length) {
    for (const id of Array.isArray(record.options) ? record.options : []) {
      if (typeof id === 'string' && id.trim() !== '' && !options.has(id)) options.set(id, { id });
    }
  }
  return [...options.values()];
}

/**
 * Catalogs for every provider, read in parallel. A provider whose catalog
 * fails or is slower than the timeout gets an empty list: its members run on
 * their default model, and the Planner reports a requested model as not covered.
 */
export async function loadModelCatalogs(
  providers: string[],
  load: (provider: string) => Promise<unknown>,
  timeoutMs = 10_000,
): Promise<Record<string, ModelOption[]>> {
  const entries = await Promise.all(
    [...new Set(providers)].map(async (provider) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const config = await Promise.race([
          load(provider),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);
        return [provider, catalogOptions(config)] as const;
      } catch (error) {
        console.warn(`[Workflow] could not read ${provider}'s model catalog:`, error instanceof Error ? error.message : error);
        return [provider, []] as const;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return Object.fromEntries(entries);
}

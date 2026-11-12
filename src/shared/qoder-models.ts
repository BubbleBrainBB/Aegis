/**
 * Telling Qoder's models apart.
 *
 * Aegis knows a Qoder model by its id (`qmodel_latest`): the picker selects
 * it, a task is saved with it, and a result is matched to the selected model
 * by it. qodercli 1.1.8x names a session's model in `system.init` as the
 * picker shows it ("Qwen4-Max-Preview"), where earlier CLIs gave the id, so a
 * name coming from the CLI can be either.
 *
 * A name alone is not always enough: two models can share a display name, and
 * one model's display name can be another's id. Nothing here picks one of
 * several candidates. A name that does not say which model it is stays as it
 * came, and the caller treats it as unresolved.
 */

export type QoderModelName = { value: string; displayName: string };

/** The model a name stands for when exactly one model has it as its id or its display name. */
export function findQoderModelByName<T extends QoderModelName>(models: readonly T[], name: string | null | undefined): T | undefined {
  const named = name?.trim();
  if (!named) return undefined;
  const fits = models.filter((model) => model.value === named || model.displayName === named);
  return fits.length === 1 ? fits[0] : undefined;
}

/** The entry with this id. An id names its own entry even when another model's display name equals it. */
export function findQoderModelById<T extends QoderModelName>(models: readonly T[], id: string | null | undefined): T | undefined {
  const wanted = id?.trim();
  return wanted ? models.find((model) => model.value === wanted) : undefined;
}

/**
 * The model a session is on, given what the CLI reported and the id Aegis
 * last asked for.
 *
 * - The CLI's name fits the asked-for model (its id or its display name): the
 *   CLI confirms it, whatever else that name could mean.
 * - Otherwise the CLI is on something else, or nothing was asked for: its name
 *   is taken when it says which model it is.
 * - Otherwise the name is kept as the CLI gave it and `resolved` is false: an
 *   unknown model, an ambiguous name, or no catalog to read it by. The asked-for
 *   id is not assumed, so a model the CLI switched to is not hidden.
 */
export function resolveReportedQoderModel(
  models: readonly QoderModelName[],
  reported: string,
  requested: string | null | undefined
): { model: string; resolved: boolean } {
  const named = reported.trim();
  const asked = requested?.trim();
  if (asked) {
    if (named === asked) return { model: asked, resolved: true };
    const entry = findQoderModelById(models, asked);
    if (entry && entry.displayName === named) return { model: asked, resolved: true };
  }
  const unique = findQoderModelByName(models, named);
  return unique ? { model: unique.value, resolved: true } : { model: named, resolved: false };
}

/**
 * The display name results may carry in place of this model's id (results
 * saved from qodercli 1.1.8x before ids were restored), or null when that
 * name could also mean another model: one that shares it, or one whose id it is.
 */
export function qoderModelNameAlias(models: readonly QoderModelName[], id: string | null | undefined): string | null {
  const entry = findQoderModelById(models, id);
  const name = entry?.displayName.trim();
  if (!entry || !name || name === entry.value) return null;
  const alsoMeans = models.some((model) => model !== entry && (model.value === name || model.displayName === name));
  return alsoMeans ? null : name;
}

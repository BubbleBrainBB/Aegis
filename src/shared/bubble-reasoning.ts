/**
 * Bubble models whose thinking only switches on and off (GLM-5.1, Kimi K2.6,
 * MiMo V2.6: main process, renderer and the phone all read this).
 *
 * The SDK's catalog lists such a model with exactly "off" and "medium", and
 * "medium" is what a turn sends for on: the SDK has no "on" level. It is not
 * a grade, so nothing shown to a person calls it "Medium".
 */
export const BUBBLE_THINKING_ON_LEVEL = 'medium';

/** The SDK's isThinkingToggleLevels rule (dist/variant/variant-resolver.js). */
export function isBubbleThinkingToggle(levels: readonly string[] | null | undefined): boolean {
  return !!levels && levels.length === 2 && levels.includes('off') && levels.includes(BUBBLE_THINKING_ON_LEVEL);
}

/** The level a turn sends for a name a person or a plan uses: "on" is the switch's "medium". */
export function bubbleThinkingWireLevel(level: string): string {
  return level.trim().toLowerCase() === 'on' ? BUBBLE_THINKING_ON_LEVEL : level;
}

/**
 * A model's levels under the names they are shown and asked for by: a switch
 * is "off" and "on", graded levels keep the SDK's names.
 */
export function bubbleThinkingLevelNames(levels: readonly string[]): string[] {
  return isBubbleThinkingToggle(levels) ? ['off', 'on'] : [...levels];
}

/** One level under the name it is shown by: "on" for a switch's "medium". */
export function bubbleThinkingLevelName(level: string, levels: readonly string[] | null | undefined): string {
  return level === BUBBLE_THINKING_ON_LEVEL && isBubbleThinkingToggle(levels) ? 'on' : level;
}

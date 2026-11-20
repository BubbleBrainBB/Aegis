import type { RemoteTaskSettings } from "./protocol";

// What this device chose for a session that runs on another Mac.
//
// A choice waits until a message carries it there: nothing that Mac reports in
// the meantime ends it, since what it reports is the past (the report of an
// earlier message must not undo a choice made after that message left).
//
// Once a message has carried it, the other Mac answers for the field. How its
// answer is recognized depends on that Mac:
//
// - A newer one keeps the field on the session, says it in every report, and
//   numbers its reports (`version`). Any report newer than the one that was
//   here when the message left is its answer, whatever value it holds: it took
//   the choice, or the session has moved on since (an approved plan, a message
//   sent from elsewhere). The value alone could not tell: a session put back
//   to what it was before the message looks unchanged.
// - An older one may never report the field (no mode for some agents), so the
//   choice stands until the value it reports for the field changes, which may
//   be never. Every message from here then says it again.

type Field = keyof RemoteTaskSettings;

/** What the other Mac says of a session. */
export interface Reported {
  settings?: RemoteTaskSettings;
  /** Newer Macs: rises whenever the session changes there. */
  version?: number;
  /** Newer Macs: the fields the session keeps when a message leaves them out. */
  keeps?: readonly string[];
}

/**
 * What a message is sent with, what the other Mac had said when it left, and
 * which choices it carries (`ChosenSettings.picked` as it was then).
 */
export interface Sending {
  settings: RemoteTaskSettings;
  reported: Reported | undefined;
  picked: Partial<Record<Field, number>>;
}

export interface ChosenSettings {
  /** The fields chosen here. A field set to undefined was cleared on purpose. */
  settings: RemoteTaskSettings;
  /** What the other Mac said for each field when it was chosen, or when the message carrying it left. */
  seen: RemoteTaskSettings;
  /** The fields a message has carried to the other Mac since they were chosen. */
  sent: Field[];
  /** For a sent field a newer Mac answers for: the version of its report that was here when the message left. */
  sentAt: Partial<Record<Field, number>>;
  /**
   * Which choice each field holds: a number no other choice has, of this field
   * or any other. Choosing a field again is another choice though its value be
   * one chosen before, and the answer to a message that carried the earlier one
   * says nothing of it.
   */
  picked: Partial<Record<Field, number>>;
}

let choices = 0;

const fields = (settings: RemoteTaskSettings) => Object.keys(settings) as Field[];

function only(chosen: ChosenSettings, keep: Field[]): ChosenSettings | undefined {
  if (!keep.length) return undefined;
  const next: ChosenSettings = { settings: {}, seen: {}, sent: chosen.sent.filter((field) => keep.includes(field)), sentAt: {}, picked: {} };
  for (const field of keep) {
    (next.settings as Record<Field, unknown>)[field] = chosen.settings[field];
    (next.seen as Record<Field, unknown>)[field] = chosen.seen[field];
    if (field in chosen.sentAt) next.sentAt[field] = chosen.sentAt[field];
    next.picked[field] = chosen.picked[field];
  }
  return next;
}

/** `picked` added to the choices already made; `reported` is what the other Mac says now. Each waits to be sent. */
export function chooseSettings(
  chosen: ChosenSettings | undefined,
  reported: Reported | undefined,
  picked: RemoteTaskSettings,
): ChosenSettings | undefined {
  const kept = pruneChosen(chosen, reported);
  const picks = fields(picked);
  if (!picks.length) return kept;
  const next: ChosenSettings = {
    settings: { ...kept?.settings },
    seen: { ...kept?.seen },
    sent: (kept?.sent ?? []).filter((field) => !picks.includes(field)),
    sentAt: { ...kept?.sentAt },
    picked: { ...kept?.picked },
  };
  for (const field of picks) {
    (next.settings as Record<Field, unknown>)[field] = picked[field];
    (next.seen as Record<Field, unknown>)[field] = reported?.settings?.[field];
    delete next.sentAt[field];
    next.picked[field] = ++choices;
  }
  return next;
}

/**
 * A message reached the other Mac. The choices it carried are that Mac's to
 * answer from now on, measured from what it had said when the message left
 * (`sending.reported`), not from what it says by the time the answer is here:
 * a report that arrived in between is already newer than the message.
 * A field chosen again since still waits, whatever it was chosen to: this
 * message did not carry that choice. Its value may be the one this message
 * said (Default, then Full Access, then Default again while the first answer
 * is late): the later choice has yet to reach the other Mac, which is on
 * whatever came between.
 */
export function markSent(chosen: ChosenSettings | undefined, sending: Sending): ChosenSettings | undefined {
  if (!chosen) return undefined;
  const { settings: delivered, reported } = sending;
  const carried = fields(chosen.settings).filter((field) =>
    !chosen.sent.includes(field)
    && sending.picked[field] === chosen.picked[field]
    // Said in the message, or cleared (which a message says by leaving it out).
    && delivered[field] === chosen.settings[field]);
  if (!carried.length) return chosen;
  const next: ChosenSettings = { settings: { ...chosen.settings }, seen: { ...chosen.seen }, sent: [...chosen.sent, ...carried], sentAt: { ...chosen.sentAt }, picked: { ...chosen.picked } };
  for (const field of carried) {
    (next.seen as Record<Field, unknown>)[field] = reported?.settings?.[field];
    if (reported?.version !== undefined && reported.keeps?.includes(field)) next.sentAt[field] = reported.version;
  }
  return next;
}

/**
 * Forgets the fields cleared here that a message has since gone without. A
 * message cannot say "none": it leaves the field out, and the other Mac keeps
 * what it had. From then on what that Mac reports for the field is all there
 * is to show; holding the clear would show a value the session does not run with.
 */
export function forgetCleared(chosen: ChosenSettings | undefined): ChosenSettings | undefined {
  if (!chosen) return undefined;
  const all = fields(chosen.settings);
  const kept = all.filter((field) => !(chosen.settings[field] === undefined && chosen.sent.includes(field)));
  return kept.length === all.length ? chosen : only(chosen, kept);
}

/**
 * The choices that still stand: those waiting to be sent, and those sent that
 * the other Mac has not answered for since. Returns `chosen` itself when all
 * of them do, so callers can tell.
 */
export function pruneChosen(chosen: ChosenSettings | undefined, reported: Reported | undefined): ChosenSettings | undefined {
  if (!chosen) return undefined;
  const all = fields(chosen.settings);
  const standing = all.filter((field) => {
    if (!chosen.sent.includes(field)) return true;
    const sentAt = chosen.sentAt[field];
    if (sentAt !== undefined) return !(reported?.version !== undefined && reported.version > sentAt);
    return reported?.settings?.[field] === chosen.seen[field];
  });
  return standing.length === all.length ? chosen : only(chosen, standing);
}

/** What the session should run with: the other Mac's settings, under the choices that still stand. */
export function effectiveSettings(reported: Reported | undefined, chosen: ChosenSettings | undefined): RemoteTaskSettings {
  return { ...reported?.settings, ...pruneChosen(chosen, reported)?.settings };
}

/** The choices no message has carried yet. */
export function waitingSettings(chosen: ChosenSettings | undefined): RemoteTaskSettings {
  if (!chosen) return {};
  return only(chosen, fields(chosen.settings).filter((field) => !chosen.sent.includes(field)))?.settings ?? {};
}

/**
 * What a message with no composer behind it (the main bot's) tells the other
 * Mac to run with. A field that Mac keeps is said only when it was chosen here
 * and has not gone out yet: its own value is newer than the copy of it here,
 * and saying that copy back would undo a change made there since. Every other
 * field is said in full: left out, that Mac would put it back on a default.
 */
export function settingsToSend(reported: Reported | undefined, chosen: ChosenSettings | undefined): RemoteTaskSettings {
  const settings = effectiveSettings(reported, chosen);
  const waiting = waitingSettings(pruneChosen(chosen, reported));
  for (const field of reported?.keeps ?? []) {
    if (!(field in waiting)) delete (settings as Record<string, unknown>)[field];
  }
  return settings;
}

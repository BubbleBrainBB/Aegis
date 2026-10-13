/** Artboard display names, matching Claude Design's recovered canvas rules. */
export const DESIGN_NAME_LIMIT = 120;
export function normalizeBoardName(value: string | undefined): string | undefined {
  const name = value?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, DESIGN_NAME_LIMIT);
  return name || undefined;
}
export function nextBoardName(boards: readonly { name: string }[]): string {
  let max = 0;
  for (const board of boards) {
    const match = /^Artboard(?: ?(\d{1,9}))?$/.exec(board.name);
    if (match) max = Math.max(max, match[1] ? Number(match[1]) : 1);
  }
  return `Artboard ${max + 1}`;
}
export function copyBoardName(name: string, boards: readonly { name: string }[]): string {
  const base = name.replace(/ copy(?: \d{1,9})?$/, "").slice(0, DESIGN_NAME_LIMIT - 10);
  const names = new Set(boards.map(board => board.name));
  if (!names.has(`${base} copy`)) return `${base} copy`;
  let n = 2;
  while (names.has(`${base} copy ${n}`)) n++;
  return `${base} copy ${n}`;
}

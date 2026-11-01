import { constants, promises as fs } from 'fs';
import {
  BACKGROUND_OUTPUT_TAIL_BYTES,
  cleanTerminalOutput,
  type BackgroundTaskOutput,
} from '../../shared/background-task-output';

/**
 * The end of a background command's output file, cleaned for display. A file
 * the command hasn't created yet reads as empty output. Only a regular file
 * is read: a symlink in its place is refused, never followed.
 */
export async function readBackgroundOutputTail(
  path: string,
  maxBytes = BACKGROUND_OUTPUT_TAIL_BYTES
): Promise<BackgroundTaskOutput> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', truncated: false };
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Not a regular file.');
    const { size } = stat;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    let text = buffer.toString('utf8');
    // Cut mid-file: drop the partial first line (and any split character).
    if (size > length) text = text.slice(text.indexOf('\n') + 1);
    return { text: cleanTerminalOutput(text), truncated: size > length };
  } finally {
    await handle.close();
  }
}

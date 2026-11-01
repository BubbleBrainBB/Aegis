import { useEffect, useState } from 'react';
import { useAppPreferences } from '../store/useAppPreferences';

export interface ChatsFolder {
  path: string;
  /** With the home folder shown as ~. */
  display: string;
}

const DEFAULT_DISPLAY = '~/Documents/Aegis';

/** Where chats without a project get their folders; follows Settings › General. */
export function useChatsFolder(): ChatsFolder {
  const setting = useAppPreferences((state) => state.chatsFolder);
  const [folder, setFolder] = useState<ChatsFolder>({ path: setting, display: setting || DEFAULT_DISPLAY });
  useEffect(() => {
    let active = true;
    window.electron?.getChatsFolder?.().then((next) => {
      if (active && next) setFolder(next);
    }).catch(() => { /* Keep the default label. */ });
    return () => { active = false; };
  }, [setting]);
  return folder;
}

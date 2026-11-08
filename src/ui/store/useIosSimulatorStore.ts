import { create } from 'zustand';
import type { IosSimulatorStatus, IosSimulatorView } from '../../shared/ios-simulator';

interface IosSimulatorStore {
  status: IosSimulatorStatus | null;
  views: Record<string, IosSimulatorView>;
  setStatus: (status: IosSimulatorStatus) => void;
  setView: (view: IosSimulatorView) => void;
}

export const useIosSimulatorStore = create<IosSimulatorStore>((set) => ({
  status: null,
  views: {},
  setStatus: (status) => set({ status }),
  setView: (view) => set((state) => ({ views: { ...state.views, [view.device.udid]: view } })),
}));

let subscribed = false;

/** Device state pushed by the main process keeps every pane and tab label current. */
export function subscribeIosSimulatorState(): void {
  if (subscribed || !window.electron?.iosSimulator) return;
  subscribed = true;
  window.electron.iosSimulator.onState((view) => useIosSimulatorStore.getState().setView(view));
}

export async function loadIosSimulatorStatus(fresh = false): Promise<IosSimulatorStatus | null> {
  if (!window.electron?.iosSimulator) return null;
  const status = await window.electron.iosSimulator.status({ fresh });
  useIosSimulatorStore.getState().setStatus(status);
  return status;
}

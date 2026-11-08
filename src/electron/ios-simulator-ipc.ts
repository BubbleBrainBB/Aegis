import { ipcMain, type BrowserWindow } from 'electron';
import { ipcMainHandle, ipcMainOn } from './util';
import {
  IOS_SIMULATOR_CHANNELS,
  type IosSimulatorInput,
  type IosSimulatorProjectInfo,
  type IosSimulatorSessionInput,
  type IosSimulatorTouch,
} from '../shared/ios-simulator';
import { getToolchainStatus } from './libs/ios-simulator/toolchain';
import { isIosProject } from './libs/ios-simulator/project';
import {
  attachViewer,
  bootDevice,
  detachViewer,
  deviceChrome,
  getDevices,
  getView,
  requestKeyFrame,
  saveScreenshotToDesktop,
  sendPaneInput,
  sendPaneTouch,
  setAgentAllowed,
  setIosSimulatorHost,
  shutdownAegisDevicesOnQuit,
  shutdownDevice,
} from './libs/ios-simulator/service';
import { cancelSimulatorBuilds } from './libs/ios-simulator/build';

export function registerIosSimulatorIpc(
  mainWindow: BrowserWindow,
  openPanel: (sessionId: string, udid: string) => void
): void {
  const send = (channel: string, payload: unknown) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  setIosSimulatorHost({
    sendFrame: (frame) => send(IOS_SIMULATOR_CHANNELS.frame, frame),
    sendState: (view) => send(IOS_SIMULATOR_CHANNELS.state, view),
    openPanel,
  });
  // Warm the toolchain check so the agent tool list knows whether to offer it.
  void getToolchainStatus().catch(() => {});

  ipcMainHandle(IOS_SIMULATOR_CHANNELS.status, (_event, options?: { fresh?: boolean }) =>
    getToolchainStatus({ fresh: options?.fresh })
  );
  ipcMainHandle(IOS_SIMULATOR_CHANNELS.project, async (_event, cwd: string): Promise<IosSimulatorProjectInfo> => ({
    isIosProject: process.platform === 'darwin' && typeof cwd === 'string' ? await isIosProject(cwd) : false,
  }));
  ipcMainHandle(IOS_SIMULATOR_CHANNELS.devices, () => getDevices({ fresh: true }));
  ipcMainHandle(IOS_SIMULATOR_CHANNELS.view, (_event, udid: string) => getView(udid, { fresh: true }));
  ipcMainHandle(IOS_SIMULATOR_CHANNELS.boot, (_event, input: IosSimulatorSessionInput) =>
    bootDevice(input.udid, input.sessionId)
  );
  ipcMainHandle(IOS_SIMULATOR_CHANNELS.shutdown, (_event, udid: string) => shutdownDevice(udid));
  ipcMainHandle(IOS_SIMULATOR_CHANNELS.attach, (_event, input: IosSimulatorSessionInput) =>
    attachViewer(input.udid, input.sessionId)
  );
  ipcMainHandle(IOS_SIMULATOR_CHANNELS.detach, (_event, input: IosSimulatorSessionInput) => {
    detachViewer(input.udid, input.sessionId);
  });
  ipcMainHandle(IOS_SIMULATOR_CHANNELS.input, (_event, udid: string, input: IosSimulatorInput) =>
    sendPaneInput(udid, input)
  );
  // Pointer moves arrive at display rate: one-way messages, no reply. A
  // recreated window registers again, so the old listeners go first.
  ipcMain.removeAllListeners(IOS_SIMULATOR_CHANNELS.touch);
  ipcMain.removeAllListeners(IOS_SIMULATOR_CHANNELS.keyframe);
  ipcMainOn(IOS_SIMULATOR_CHANNELS.touch, (_event, touch: IosSimulatorTouch) => {
    sendPaneTouch(touch);
  });
  ipcMainOn(IOS_SIMULATOR_CHANNELS.keyframe, (_event, udid: string) => {
    requestKeyFrame(udid);
  });
  ipcMainHandle(IOS_SIMULATOR_CHANNELS.chrome, (_event, udid: string) => deviceChrome(udid));
  ipcMainHandle(IOS_SIMULATOR_CHANNELS.screenshot, (_event, udid: string) => saveScreenshotToDesktop(udid));
  ipcMainHandle(IOS_SIMULATOR_CHANNELS.setAgentAccess, (_event, udid: string, allowed: boolean) => {
    setAgentAllowed(udid, Boolean(allowed));
  });
}

/** App quit: stop the streams and shut down the devices Aegis booted. */
export function disposeIosSimulatorIpc(): void {
  setIosSimulatorHost(null);
  cancelSimulatorBuilds();
  shutdownAegisDevicesOnQuit();
}

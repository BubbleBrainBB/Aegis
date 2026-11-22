// The app's one Computer use gateway, and what the rest of the main process
// asks of it. Nothing here starts cua-driver: the driver starts on the first
// tool call, and only while the switch is on.

import path from 'path';
import type { ComputerUseDriverStatus } from '../../../shared/computer-use';
import { computerUseLease } from '../codex-computer-use';
import { computerUseGrants } from '../codex-computer-use-grants';
import { resolveCuaDriver } from './driver-binary';
import { CuaDriverHost, type ComputerUseDriver } from './driver-host';
import { ComputerUseGateway, type ComputerUseGatewayHost } from './service';
import { isComputerUseEnabled } from './settings';

let gateway: ComputerUseGateway | null = null;

export function getComputerUseDriverStatus(): ComputerUseDriverStatus {
  return resolveCuaDriver();
}

/**
 * Called once at app start. `host` answers for sessions and shows the
 * approval card; the driver's state lives under `userDataDir`.
 */
export function initializeComputerUseGateway(
  host: Omit<ComputerUseGatewayHost, 'isEnabled' | 'driverStatus'>,
  options: { hostBundleId: string; driver?: ComputerUseDriver }
): ComputerUseGateway {
  const driver =
    options.driver ??
    new CuaDriverHost({
      resolveBinary: () => {
        const status = resolveCuaDriver();
        if (status.state !== 'ready' || !status.path) {
          throw new Error(status.message || "Computer use isn't available in this build.");
        }
        return status.path;
      },
      homeDir: path.join(host.userDataDir(), 'computer-use', 'driver'),
      hostBundleId: options.hostBundleId,
    });
  gateway = new ComputerUseGateway(
    { ...host, isEnabled: isComputerUseEnabled, driverStatus: getComputerUseDriverStatus },
    driver,
    { lease: computerUseLease, grants: computerUseGrants }
  );
  return gateway;
}

export function getComputerUseGateway(): ComputerUseGateway | null {
  return gateway;
}

/** Whether agents are offered the tools right now: the switch is on and the pinned driver is there. */
export function isComputerUseAvailableNow(): boolean {
  return Boolean(gateway) && isComputerUseEnabled() && getComputerUseDriverStatus().state === 'ready';
}

/** For tests. */
export function resetComputerUseGatewayForTests(): void {
  gateway = null;
}

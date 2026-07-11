import { DesktopDriver } from "./desktopDriver.js";
import { WebDriver } from "./webDriver.js";
import type { Driver, DriverPorts, Mode } from "./types.js";

export type { Driver, DriverPorts, Mode } from "./types.js";
export { DEFAULT_PORTS } from "./types.js";

export function createDriver(mode: Mode, ports: Partial<DriverPorts> = {}): Driver {
  if (mode === "desktop") return new DesktopDriver(ports);
  if (mode === "web") return new WebDriver(ports);
  throw new Error(`未知の mode: ${mode}`);
}

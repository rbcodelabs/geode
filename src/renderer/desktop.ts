import { createElectronHost } from "./host/electron-host";
import { installHostServices } from "./host/registry";

installHostServices(createElectronHost(window.geode));
void import("./app");

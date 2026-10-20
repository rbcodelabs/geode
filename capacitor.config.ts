import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.rbcodelabs.geode",
  appName: "Geode",
  webDir: "dist/mobile",
  // Match the boot splash / launch screen so the WKWebView never flashes white before first paint.
  backgroundColor: "#1e1e1e",
};

export default config;

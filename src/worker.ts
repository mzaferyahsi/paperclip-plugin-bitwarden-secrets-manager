import { definePlugin } from "@paperclipai/plugin-sdk";
import { registerRuntime } from "./runtime.js";
import { registerSettingsActions } from "./settings-actions.js";

export default definePlugin({
  async setup(ctx) {
    registerRuntime(ctx);
    registerSettingsActions(ctx);
  },
  async onHealth() { return { status: "ok" }; },
});

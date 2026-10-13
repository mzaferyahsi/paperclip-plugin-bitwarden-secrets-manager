import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { registerRuntime } from "./runtime.js";
import { registerSettingsActions } from "./settings-actions.js";

const plugin = definePlugin({
  async setup(ctx) {
    registerRuntime(ctx);
    registerSettingsActions(ctx);
  },
  async onHealth() { return { status: "ok" }; },
});

export default plugin;
runWorker(plugin, import.meta.url);

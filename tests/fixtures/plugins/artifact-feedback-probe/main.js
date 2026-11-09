const { Plugin } = require("obsidian");

// A stand-in for the Design plugin: it registers through the public
// Plugin.registerArtifactFeedbackHandler API and records every request it gets.
module.exports.default = class ArtifactFeedbackProbe extends Plugin {
  onload() {
    const probe = (window.__feedbackProbe = {
      /** "accept" | "reject" | "reject-once" | "never" */
      mode: "accept",
      canHandle: true,
      requests: [],
      aborted: 0,
      registration: null,
      register: () => {
        probe.registration = this.registerArtifactFeedbackHandler({
          contractVersion: 1,
          canHandle: (target) => (typeof probe.canHandle === "function" ? probe.canHandle(target) : probe.canHandle === true),
          submit: async (request, context) => {
            const shot = request.screenshot;
            probe.requests.push({
              comment: request.comment,
              stale: request.stale,
              frozen: Object.isFrozen(request),
              artifact: JSON.parse(JSON.stringify(request.artifact)),
              selection: JSON.parse(JSON.stringify(request.selection)),
              screenshotOmitted: request.screenshotOmitted,
              screenshot: shot
                ? {
                    mimeType: shot.mimeType,
                    length: shot.bytes.length,
                    isUint8Array: shot.bytes instanceof Uint8Array,
                    signature: Array.from(shot.bytes.slice(0, 8)),
                    width: shot.width,
                    height: shot.height,
                    cssRect: shot.cssRect,
                    devicePixelRatio: shot.devicePixelRatio,
                    downscaled: shot.downscaled,
                  }
                : null,
              submittedAt: request.submittedAt,
            });
            context.signal.addEventListener("abort", () => { probe.aborted++; });
            if (probe.mode === "never") return new Promise(() => {});
            if (probe.mode === "reject" || (probe.mode === "reject-once" && probe.requests.length === 1)) {
              return { status: "rejected", reason: "busy", message: "The agent is still working on an earlier comment. Try again in a moment." };
            }
            return { status: "accepted", message: "Queued for the agent." };
          },
        });
        return probe.registration.status;
      },
      dispose: () => { probe.registration?.dispose(); },
    });
  }
};

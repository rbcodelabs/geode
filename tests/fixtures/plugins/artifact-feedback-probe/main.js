const { Plugin } = require("obsidian");

// A stand-in for the Design plugin: it registers through the public
// Plugin.registerArtifactFeedbackHandler API and records every request it gets.
// `register()` is the v1 handler (unchanged); `registerV2()` adds a fake contract v2 comments provider
// (ADR 0006 Addendum 1) with an in-memory store the e2e tests drive through `probe.store`.
const hex32 = (n) => n.toString(16).padStart(32, "0");
const clone = (value) => JSON.parse(JSON.stringify(value));

function makeStore() {
  return {
    storeId: "str_" + "7".repeat(32),
    revision: 1,
    health: "ok",
    notice: null,
    comments: [],
    nextOrdinal: 1,
    listeners: new Set(),
    sendMode: "sent", // "sent" | "queued"
    listCalls: 0,
    sendCalls: [],
    updateCalls: [],
  };
}

function commentFromRequest(store, request) {
  const sel = request.selection;
  const text = (sel.a11y && sel.a11y.name) || sel.textAnchor.text || "";
  const now = new Date().toISOString();
  return {
    id: "cmt_" + sel.selectionId.slice(4),
    selectionId: sel.selectionId,
    ordinal: store.nextOrdinal++,
    version: 1,
    kind: "pin",
    status: "open",
    provenance: "local",
    text: request.comment,
    createdAt: now,
    updatedAt: now,
    sentAt: null,
    artifactRevision: sel.artifactRevision,
    viewSessionId: sel.viewSessionId,
    anchor: {
      route: sel.route,
      tag: sel.tag,
      selector: sel.selector,
      selectorAlternates: clone(sel.selectorAlternates),
      textAnchor: clone(sel.textAnchor),
      landmark: sel.landmark,
      lastRect: clone(sel.boundingBox.document),
    },
    label: `${sel.tag}${text ? " " + text : ""}`.slice(0, 120),
    hasScreenshot: false,
    redacted: sel.redacted,
    send: { attempts: 0, lastOutcome: null, maybeSent: false, lastMessage: null },
  };
}

function makeProvider(store) {
  const ok = (value) => ({ status: "ok", value: clone(value) });
  const rej = (reason, message) => ({ status: "rejected", reason, message });
  const emit = (reason, ids) => {
    store.revision++;
    for (const listener of [...store.listeners]) listener({ storeId: store.storeId, revision: store.revision, reason, ids });
  };
  store.emit = emit;
  /** Test helper: add comments directly (a hand-edited or agent-edited file); `over` overrides any field. */
  store.seed = (rows) => {
    for (const row of rows) {
      const ordinal = store.nextOrdinal++;
      store.comments.push({
        id: "cmt_" + hex32(ordinal), selectionId: "sel_" + hex32(ordinal), ordinal, version: 1, kind: "pin", status: "open", provenance: "local",
        text: `Comment ${ordinal}`, createdAt: "2026-11-12T10:00:00.000Z", updatedAt: "2026-11-12T10:00:00.000Z", sentAt: null,
        artifactRevision: 1, viewSessionId: "seeded", hasScreenshot: false, redacted: false,
        send: { attempts: 0, lastOutcome: null, maybeSent: false, lastMessage: null },
        label: `${row.tag || "div"}`,
        ...row,
        anchor: { route: "/index.html", tag: "div", selector: "", selectorAlternates: [], textAnchor: { tag: "div", text: "" }, landmark: null, lastRect: null, ...(row.anchor || {}) },
      });
    }
    emit("external", "all");
  };
  const find = (id) => store.comments.find((c) => c.id === id);
  const bump = (c) => { c.version++; c.updatedAt = new Date().toISOString(); };
  return {
    capabilities: { pins: true, batchSend: true, textEdit: false },
    list: async () => {
      store.listCalls++;
      return ok({ storeId: store.storeId, revision: store.revision, health: store.health, notice: store.notice, comments: store.comments, foreignCount: store.comments.filter((c) => c.provenance === "foreign").length });
    },
    get: async (_t, id) => { const c = find(id); return c ? ok({ comment: c, selection: null }) : rej("not-found", "No such comment."); },
    save: async (_t, input) => {
      const id = "cmt_" + input.request.selection.selectionId.slice(4);
      const existing = find(id);
      if (existing) return ok({ comment: existing, created: false });
      if (store.comments.length >= 200) return rej("limit", "This artifact has the maximum number of comments.");
      const c = commentFromRequest(store, input.request);
      store.comments.push(c);
      emit("local", [c.id]);
      return ok({ comment: c, created: true });
    },
    update: async (_t, input) => {
      store.updateCalls.push(clone(input));
      const c = find(input.id);
      if (!c) return rej("not-found", "No such comment.");
      if (c.version !== input.expectedVersion) return rej("conflict", "That comment changed.");
      const action = input.change.action;
      const to = { resolve: "resolved", dismiss: "dismissed", reopen: "open", unqueue: "open" }[action];
      if (!to) return rej("invalid", "Unsupported change.");
      c.status = to;
      bump(c);
      emit("local", [c.id]);
      return ok(c);
    },
    remove: async (_t, input) => {
      const c = find(input.id);
      if (!c) return rej("not-found", "No such comment.");
      store.comments.splice(store.comments.indexOf(c), 1);
      emit("local", [input.id]);
      return ok({ id: input.id });
    },
    adopt: async (_t, input) => {
      const adopted = [];
      for (const id of input.ids) { const c = find(id); if (c && c.provenance === "foreign") { c.provenance = "local"; bump(c); adopted.push(id); } }
      if (adopted.length) emit("local", adopted);
      return ok({ adopted });
    },
    subscribe: (_t, listener) => { store.listeners.add(listener); return { dispose: () => { store.listeners.delete(listener); } }; },
    sendBatch: async (_t, input) => {
      store.sendCalls.push(clone(input));
      const ids = input.ids.map((id) => find(id)).filter(Boolean).sort((a, b) => a.ordinal - b.ordinal);
      const queued = store.sendMode === "queued";
      for (const c of ids) { c.status = queued ? "pending" : "sent"; c.sentAt = queued ? null : new Date().toISOString(); c.send.attempts++; bump(c); }
      emit("local", ids.map((c) => c.id));
      return ok({
        requestId: input.requestId,
        outcome: queued ? "queued" : "sent",
        items: ids.map((c) => ({ id: c.id, result: queued ? "queued" : "sent" })),
        message: queued ? "Queued for the agent." : "Sent.",
      });
    },
  };
}

module.exports.default = class ArtifactFeedbackProbe extends Plugin {
  onload() {
    const probe = (window.__feedbackProbe = {
      /** "accept" | "reject" | "reject-once" | "never" */
      mode: "accept",
      canHandle: true,
      requests: [],
      aborted: 0,
      registration: null,
      store: null,
      register: () => {
        probe.registration = this.registerArtifactFeedbackHandler({
          contractVersion: 1,
          canHandle: (target) => (typeof probe.canHandle === "function" ? probe.canHandle(target) : probe.canHandle === true),
          submit: (request, context) => submit(request, context),
        });
        return probe.registration.status;
      },
      /** Registers the v2 handler (its `submit` is the same v1 submit, so Send still works). */
      registerV2: () => {
        const store = (probe.store = makeStore());
        probe.registration = this.registerArtifactFeedbackHandler({
          contractVersion: 2,
          canHandle: (target) => (typeof probe.canHandle === "function" ? probe.canHandle(target) : probe.canHandle === true),
          submit: (request, context) => submit(request, context),
          comments: makeProvider(store),
        });
        return probe.registration.status;
      },
      dispose: () => { probe.registration?.dispose(); },
    });

    const submit = async (request, context) => {
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
    };
  }
};

const { Plugin } = require("obsidian");
const fs = require("node:fs");
const path = require("node:path");

// Recording Agent Threads stand-in (QA final gate). Exposes api.v1 and records every call.
module.exports.default = class StandIn extends Plugin {
  async onload() {
    const app = this.app;
    const base = app.vault.adapter.getBasePath();
    const si = (window.__si = {
      calls: [], threads: new Map(), providers: [], tools: [], slash: [],
      settings: { escalationKeyword: "/escalate" },
      sendMode: "ok", // ok | throw | hang-once
      sendDelayMs: 0,
      runs: 0,
    });
    this.settings = si.settings;
    const rec = (method, args) => {
      let a;
      try { a = JSON.parse(JSON.stringify(args ?? null)); } catch { a = String(args); }
      si.calls.push({ t: Date.now(), method, args: a });
    };
    const listeners = new Set();
    const ok = (extra = {}) => ({ success: true, dispose() {}, ...extra });
    const err = (code) => Object.assign(new Error(code), { code });
    const v1 = {
      apiVersion: 1, generation: "qf-1",
      capabilities: [
        "threads.beginProvisional","threads.send","threads.open","threads.permissions","threads.subscribe","threads.wait",
        "artifacts.list","artifacts.allocateStorage","artifacts.attach","artifacts.update","artifacts.invokeAction","artifacts.visibleStorage",
        "extensions.registerArtifactProvider","extensions.registerAgentTool","extensions.registerSlashCommand",
      ],
      threads: {
        async get(id) { rec("threads.get", { id }); const t = si.threads.get(id); return t ? { id: t.id, cwd: t.cwd, artifacts: t.artifacts, isRunning: t.isRunning } : null; },
        async beginProvisional(owner, input) { rec("threads.beginProvisional", { owner, input }); throw new Error("not used"); },
        async send(id, input) {
          rec("threads.send", { id, input });
          const t = si.threads.get(id);
          if (!t) throw err("THREAD_NOT_FOUND");
          if (si.sendMode === "throw") throw new Error("boom");
          if (t.isRunning) throw err("THREAD_BUSY");
          if (si.sendMode === "hang-once") { si.sendMode = "ok"; await new Promise(() => {}); }
          if (si.sendDelayMs) await new Promise((r) => setTimeout(r, si.sendDelayMs));
          // idempotency: the same key returns the same run
          t.keys = t.keys || new Map();
          const key = input && input.idempotencyKey;
          if (key && t.keys.has(key)) return { runId: t.keys.get(key) };
          const runId = "run-" + ++si.runs;
          if (key) t.keys.set(key, runId);
          if (si.autoRun) t.isRunning = true;
          if (si.hangAfterDeliver) { si.hangAfterDeliver = false; await new Promise(() => {}); } // delivered, but the answer never comes back
          return { runId };
        },
        async open(id) { rec("threads.open", { id }); },
        subscribe(listener) { rec("threads.subscribe", {}); listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
        async wait(runId, options) { rec("threads.wait", { runId, options }); return { status: "completed" }; },
        async permissions(id) { rec("threads.permissions", { id }); return { effectivePermissionMode: "default", planApprovalPending: false }; },
      },
      artifacts: {
        async list(threadId) { rec("artifacts.list", { threadId }); return si.threads.get(threadId)?.artifacts ?? []; },
        async allocateStorage(threadId, artifactId, options) {
          rec("artifacts.allocateStorage", { threadId, artifactId, options });
          const dir = options && options.location === "visible"
            ? path.join(base, "Artifacts", "threads-design", options.folderName || artifactId)
            : path.join(base, ".geode", "artifacts", artifactId);
          fs.mkdirSync(dir, { recursive: true });
          return { success: true, path: dir, artifactId, status: "allocated" };
        },
        async attach(owner, threadId, ref) { rec("artifacts.attach", { owner, threadId, ref }); si.threads.get(threadId).artifacts.push(ref); return { success: true }; },
        async update(owner, threadId, artifactId, patch) {
          rec("artifacts.update", { owner, threadId, artifactId, patch });
          const t = si.threads.get(threadId); const i = t.artifacts.findIndex((r) => r.id === artifactId);
          if (i >= 0) t.artifacts[i] = { ...t.artifacts[i], ...patch };
          return { success: true };
        },
        async invokeAction(threadId, artifactId, actionId) {
          rec("artifacts.invokeAction", { threadId, artifactId, actionId });
          const ref = si.threads.get(threadId).artifacts.find((r) => r.id === artifactId);
          const prov = si.providers.find((p) => p.contribution.kinds.includes(ref.kind));
          const host = {
            async openView(state) { rec("host.openView", state); await app.openArtifact(state.state.root); return "tab"; },
            async revealInFolder(p) { rec("host.revealInFolder", { p }); return false; },
            async updateArtifact(patch) { rec("host.updateArtifact", patch); },
          };
          return prov.contribution.invoke(actionId, ref, host);
        },
      },
      extensions: {
        registerArtifactProvider(owner, contribution) { rec("register.provider", { owner, kinds: contribution.kinds }); si.providers.push({ owner, contribution }); return ok(); },
        registerAgentTool(owner, c) { rec("register.tool", { owner, name: c.name }); si.tools.push(c); return ok(); },
        registerSlashCommand(owner, c) { rec("register.slash", { owner, name: c.name }); si.slash.push(c); return ok(); },
      },
    };
    this.api = { v1 };
    si.newThread = (id, cwd) => { si.threads.set(id, { id, cwd, artifacts: [], isRunning: false }); };
    // A hand-made design artifact: the thread named in artifact.json must list a design-static ref with this storageRoot.
    si.attachRef = (threadId, ref) => { if (!si.threads.has(threadId)) si.newThread(threadId, "/tmp"); si.threads.get(threadId).artifacts.push(ref); };
    si.setRunning = (threadId, running) => {
      const t = si.threads.get(threadId); t.isRunning = !!running;
      if (!running) for (const l of [...listeners]) l({ kind: "run.completed", threadId, runId: "run-x" });
    };
    si.runDesign = async (threadId, args) => {
      const cmd = si.slash.find((c) => c.name === "design");
      const reports = [];
      const res = await cmd.thread.invoke({ surface: "thread", text: "/design " + args, args, threadId, hasImages: false, hasAttachment: false },
        { signal: new AbortController().signal, report: (m, e) => reports.push({ m, e: !!e }) });
      return { res, reports };
    };
    si.emit = (event) => { for (const l of [...listeners]) l(event); };
    si.sends = () => si.calls.filter((c) => c.method === "threads.send");
    app.workspace.trigger && app.workspace.trigger("claude-threads:api-ready");
  }
};

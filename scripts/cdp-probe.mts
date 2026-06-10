#!/usr/bin/env node
// Probe the running Geode renderer over CDP: report console errors and UI state.
const targets = await (await fetch("http://localhost:9223/json")).json();
const page = targets.find((t: any) => t.type === "page");
if (!page) throw new Error("No page target");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map<number, (v: any) => void>();
const errors: string[] = [];

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data as string);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  } else if (msg.method === "Runtime.exceptionThrown") {
    errors.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
  } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    errors.push(msg.params.args.map((a: any) => a.value ?? a.description).join(" ").slice(0, 300));
  }
};

function send(method: string, params: any = {}): Promise<any> {
  return new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

async function evalJs(expression: string): Promise<any> {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return res.result?.result?.value ?? res.result?.result?.description ?? null;
}

await new Promise((r) => (ws.onopen = r));
await send("Runtime.enable");

const script = process.argv[2];
if (script) {
  console.log("EVAL:", JSON.stringify(await evalJs(script), null, 2));
} else {
  console.log("UI:", JSON.stringify(await evalJs(`({
    bodyClass: document.body.className,
    hasVaultPicker: !!document.querySelector('.vault-picker'),
    hasWorkspace: !!document.querySelector('.workspace'),
    tabCount: document.querySelectorAll('.workspace-tab-header').length,
    fileTreeItems: document.querySelectorAll('.nav-item').length,
    sidebarIcons: [...document.querySelectorAll('.sidebar-icon')].map(e => e.title),
  })`), null, 2));
}
await new Promise((r) => setTimeout(r, 500));
console.log("CONSOLE ERRORS:", errors.length ? errors : "none");
ws.close();
process.exit(0);

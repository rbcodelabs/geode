import { getRecentMeasures } from "../perf-instrumentation";
import type { ProcessMetric } from "../../main/process-metrics";

const POLL_INTERVAL_MS = 2000;
/** Cap the operations table so a very active session doesn't render an unbounded list. */
const MAX_MEASURES_SHOWN = 100;

function relativeTime(ts: number): string {
  const deltaMs = Date.now() - ts;
  if (deltaMs < 1000) return "just now";
  const s = Math.round(deltaMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function renderMeasuresTable(container: HTMLElement): void {
  container.innerHTML = "";
  const heading = document.createElement("h3");
  heading.textContent = "Recent operations";
  container.appendChild(heading);

  const measures = getRecentMeasures().slice().reverse(); // newest first
  if (!measures.length) {
    const empty = document.createElement("div");
    empty.className = "setting-item-description";
    empty.textContent = "No operations recorded yet — switch tabs or open a note to generate data.";
    container.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "performance-tab-table";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Operation</th><th>Duration</th><th>When</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const m of measures.slice(0, MAX_MEASURES_SHOWN)) {
    const tr = document.createElement("tr");
    const opTd = document.createElement("td");
    opTd.textContent = m.op;
    const durTd = document.createElement("td");
    durTd.textContent = `${m.durationMs.toFixed(1)} ms`;
    const whenTd = document.createElement("td");
    whenTd.textContent = relativeTime(m.ts);
    tr.append(opTd, durTd, whenTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

function renderProcessTable(container: HTMLElement, metrics: ProcessMetric[]): void {
  container.innerHTML = "";
  const heading = document.createElement("h3");
  heading.textContent = "Process metrics";
  container.appendChild(heading);

  if (!metrics.length) {
    const empty = document.createElement("div");
    empty.className = "setting-item-description";
    empty.textContent = "No process metrics available yet.";
    container.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "performance-tab-table";
  const thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Type</th><th>PID</th><th>CPU</th><th>Memory</th></tr>";
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const m of metrics) {
    const tr = document.createElement("tr");
    const typeTd = document.createElement("td");
    typeTd.textContent = m.type;
    const pidTd = document.createElement("td");
    pidTd.textContent = String(m.pid);
    const cpuTd = document.createElement("td");
    cpuTd.textContent = `${m.cpuPercent.toFixed(1)}%`;
    const memTd = document.createElement("td");
    memTd.textContent = `${m.memoryMb.toFixed(1)} MB`;
    tr.append(typeTd, pidTd, cpuTd, memTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}

/**
 * Render the Settings -> Performance tab into `container`: a table of
 * recent operation-boundary measures (`perf-instrumentation.ts`) and a
 * live-polled table of per-process CPU/memory (`window.geode.getProcessMetrics()`,
 * `src/main/process-metrics.ts`).
 *
 * Polling starts immediately (the tab is visible when this is called) on a
 * ~2s interval and keeps refreshing the operations table too, so both stay
 * current while the tab is open. Callers MUST call the returned cleanup
 * function exactly once, when the tab is deactivated or the modal closes —
 * otherwise the interval leaks and keeps polling in the background.
 */
export function renderPerformanceTab(container: HTMLElement): () => void {
  // `container.innerHTML = ""` only, not `container.className = ...` --
  // `container` is the SettingsModal's shared `.vertical-tab-content-container`
  // (scrollable, padded; see activateTab/onOpen in app.ts). Overwriting its
  // className here previously stripped that class, breaking scrolling at
  // small window sizes where these tables overflow the modal's visible
  // height, and `contentContainerEl.empty()` (used on every tab switch)
  // never resets className, so any class added here would leak onto other
  // tabs too -- style via the child elements below instead.
  container.innerHTML = "";
  const heading = document.createElement("h2");
  heading.textContent = "Performance";
  container.appendChild(heading);

  const measuresSection = document.createElement("div");
  measuresSection.className = "performance-tab-section";
  container.appendChild(measuresSection);

  const processSection = document.createElement("div");
  processSection.className = "performance-tab-section";
  container.appendChild(processSection);

  renderMeasuresTable(measuresSection);
  renderProcessTable(processSection, []);

  let disposed = false;

  const poll = async () => {
    try {
      const metrics = await window.geode.getProcessMetrics();
      if (disposed) return;
      renderProcessTable(processSection, metrics);
    } catch (err) {
      console.error("Failed to fetch process metrics", err);
    }
    if (disposed) return;
    renderMeasuresTable(measuresSection); // refresh operation timings on every poll tick too
  };

  void poll();
  const intervalId = setInterval(poll, POLL_INTERVAL_MS);

  return () => {
    if (disposed) return;
    disposed = true;
    clearInterval(intervalId);
  };
}

import type { FdPressureSnapshot } from "../../main/crash-diagnostics";

/**
 * A `<webview>` guest is the only renderer in Geode that runs sandboxed, so it
 * is the only one that needs a spare file descriptor at launch to receive its
 * seatbelt policy. When the process descriptor table is saturated that
 * handshake fails and the guest aborts before Chromium is even initialized,
 * which the user sees as a bare "crashed (exit code 6)".
 *
 * Returns a replacement overlay message when the numbers say descriptors are
 * the problem, or `null` to leave the generic crash message alone.
 */
export function describeGuestCrashCause(
  summary: string,
  pressure: FdPressureSnapshot | null,
): { title: string; detail: string } | null {
  if (!pressure?.underPressure) return null;
  const usage = pressure.limit !== null && pressure.openFileDescriptors !== null
    ? `${pressure.openFileDescriptors} of ${pressure.limit} available file handles are in use`
    : "this process has run out of file handles";
  return {
    title: "This page crashed — out of file handles",
    // The raw crash reason is kept rather than replaced: it is still the only
    // thing that distinguishes one failure from another in a bug report.
    detail: `${summary}. ${usage}, so the sandboxed page process could not start. `
      + "This usually means a very large vault is being watched; restarting Geode frees the handles.",
  };
}

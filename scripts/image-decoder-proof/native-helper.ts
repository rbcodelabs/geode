import { ImageInspectionSession, type ImageBytes, type ImageIntent, type ImageSessionAdapter } from "../../src/renderer/image-inspection/image-session";

interface Fixture {
  family: string; mime: ImageBytes["mime"]; path: string; bytes: number[]; sha256: string; width: number; height: number;
  reader: { mime: string; bytes: number; sha256: string };
}
interface EventRecord { seq: number; name: string; id: string; scenario?: string; path?: string; url?: string; [key: string]: unknown }
interface Context { id: string; path: string; scenario?: string }
function requireProof(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function observedSession(lookup: Map<string, Fixture>, events: EventRecord[], scenario?: string) {
  const ownerToken = {}, file = {}, vault = {}, owned = new Map<string, { context: Context; revokes: number }>();
  const contexts = new Map<string, Context>(); let active: Context | undefined;
  let image: HTMLImageElement | undefined, detach: (() => void) | undefined;
  let onDecode: ((observation: { settled: () => boolean; outcome: () => string | undefined }) => void) | undefined;
  const emit = (context: Context, name: string, extra: Record<string, unknown> = {}) => {
    events.push({ seq: events.length + 1, ...context, name, ...extra });
  };
  const adapter: ImageSessionAdapter = {
    read: (intent, id) => {
      const fixture = lookup.get(intent.path); requireProof(fixture, "No synthetic fixture capability for this path.");
      const context = { id, path: intent.path, ...(scenario ? { scenario } : {}) }; active = context; contexts.set(id, context);
      emit(context, "readStart");
      // Main already read/hashed these exact bytes through the real private reader.
      // This is an injected prepared-byte capability, not product IPC or native I/O.
      return Promise.resolve({ bytes: Uint8Array.from(fixture.bytes).buffer, mime: fixture.mime }).then(value => { emit(context, "readSettled"); return value; });
    },
    cancel: (_intent, id) => {
      const context = contexts.get(id); requireProof(context && context === active, "Cancellation must retain the exact active request ID.");
      emit(context, "cancel"); emit(context, "cancelSettled");
    },
    createURL: value => {
      requireProof(active, "URL creation has an admitted owner.");
      const url = URL.createObjectURL(new Blob([value.bytes], { type: value.mime }));
      requireProof(!owned.has(url), "Native URL identities must be unique.");
      owned.set(url, { context: active, revokes: 0 }); emit(active, "urlCreate", { url }); return url;
    },
    decode: url => {
      const record = owned.get(url); requireProof(record && record.revokes === 0, "Decode only owns a live URL.");
      const context = record.context, target = document.createElement("img"); image = target;
      const load = () => emit(context, "load", { url, width: target.naturalWidth, height: target.naturalHeight });
      const error = () => emit(context, "error", { url });
      target.addEventListener("load", load); target.addEventListener("error", error);
      detach = () => { target.removeEventListener("load", load); target.removeEventListener("error", error); };
      document.body.appendChild(target); target.src = url;
      const native = target.decode(); let settled = false, outcome: string | undefined;
      emit(context, "decodeStart", { url, srcAttribute: target.getAttribute("src"), currentSrc: target.currentSrc });
      const observed = native.then(() => {
        settled = true; outcome = "fulfilled";
        emit(context, "decodeSettled", { url, outcome, width: target.naturalWidth, height: target.naturalHeight, currentSrc: target.currentSrc });
        return { width: target.naturalWidth, height: target.naturalHeight };
      }, error => {
        settled = true; outcome = "rejected";
        emit(context, "decodeSettled", { url, outcome, errorName: error?.name ?? "unknown", currentSrc: target.currentSrc });
        throw error;
      });
      onDecode?.({ settled: () => settled, outcome: () => outcome });
      return observed;
    },
    hide: () => { requireProof(active, "Hide retains a context."); if (image) image.hidden = true; emit(active, "hide"); },
    clear: () => {
      requireProof(active, "Clear retains a context."); image?.removeAttribute("src"); image?.remove();
      emit(active, "clear", { srcAttribute: image?.getAttribute("src") ?? null, currentSrc: image?.currentSrc ?? "" });
    },
    release: () => { requireProof(active, "Release retains a context."); detach?.(); detach = undefined; image = undefined; emit(active, "release"); },
    revoke: url => {
      const record = owned.get(url); requireProof(record && record.revokes === 0, "Exactly one revoke attempt per exact owned URL.");
      record.revokes++; URL.revokeObjectURL(url); emit(record.context, "urlRevoke", { url });
    },
    publish: (url, dimensions) => {
      const record = owned.get(url); requireProof(record && record.revokes === 0 && image?.isConnected, "Publish only the actual current native image.");
      emit(record.context, "publish", { url, ...dimensions, currentSrc: image.currentSrc, connected: image.isConnected });
    },
  };
  const session = new ImageInspectionSession(ownerToken, adapter);
  const intent = (path: string): ImageIntent => ({ ownerToken, file, vault, root: "/synthetic-proof-fixtures", path, snapshot: `![[${path}]]`, current: () => true });
  return {
    session, owned, intent,
    watchDecode: (callback: typeof onDecode) => { onDecode = callback; },
    close: async () => {
      requireProof(active, "Close has an admitted request context."); const context = active; emit(context, "closeStart");
      const closing = session.close(); requireProof(session.close() === closing, "Repeated close must retain its promise.");
      await closing; emit(context, "closeSettled");
    },
    proveRevoked: async () => {
      requireProof(owned.size === 1, "One positive owned URL.");
      const [url, record] = [...owned][0]; const probe = document.createElement("img"); probe.src = url;
      let rejected = false;
      try { await probe.decode(); } catch (error) { rejected = error instanceof DOMException && error.name === "EncodingError"; }
      finally { probe.removeAttribute("src"); probe.remove(); }
      requireProof(rejected, "Fresh native decode must reject the revoked positive URL.");
      emit(record.context, "revokedProbeRejected", { url });
    },
  };
}
function started(state: ReturnType<typeof observedSession>) {
  let resolve!: (value: { settled: () => boolean; outcome: () => string | undefined }) => void;
  const promise = new Promise<{ settled: () => boolean; outcome: () => string | undefined }>(done => { resolve = done; });
  state.watchDecode(resolve); return promise;
}
const errorResult = async (promise: Promise<void>) => {
  try { await promise; return undefined; } catch (error) { return error; }
};
function allRevoked(state: ReturnType<typeof observedSession>) { return [...state.owned.values()].every(record => record.revokes === 1); }

export async function run(fixtures: Fixture[], corrupt: Fixture) {
  const families = [];
  for (const fixture of fixtures) {
    const events: EventRecord[] = [], lookup = new Map([[fixture.path, fixture]]);
    const positive = observedSession(lookup, events, "positive");
    await positive.session.show(positive.intent(fixture.path));
    const published = events.find(event => event.name === "publish"); requireProof(published, "Actual native publication required.");
    requireProof(published.width === fixture.width && published.height === fixture.height, "Actual native natural dimensions match fixture.");
    await positive.close(); await positive.proveRevoked();
    const before = observedSession(lookup, events, "beforeDecode");
    const beforeShowing = errorResult(before.session.show(before.intent(fixture.path)));
    await before.close(); requireProof(await beforeShowing instanceof Error, "Pre-admission close rejects obsolete show.");
    requireProof(before.owned.size === 0, "No URL before native admission.");
    const pending = observedSession(lookup, events, "pendingClose"), admission = started(pending);
    const pendingShowing = errorResult(pending.session.show(pending.intent(fixture.path)));
    const observation = await admission; const pendingAtClose = !observation.settled();
    requireProof(pendingAtClose, "Actual native decode Promise must be observed pending at close.");
    await pending.close(); requireProof(await pendingShowing instanceof Error, "Pending-close show cannot publish success.");
    requireProof(observation.settled(), "Native decode Promise actually settled before close completed.");
    const owned = [...positive.owned, ...pending.owned];
    requireProof(owned.length === 2 && new Set(owned.map(([url]) => url)).size === 2 && allRevoked(positive) && allRevoked(pending), "Exact once-only URL ownership.");
    families.push({ family: fixture.family, mime: fixture.mime, bytes: fixture.bytes.length, sha256: fixture.sha256, width: fixture.width, height: fixture.height, reader: fixture.reader,
      positive: { settled: true, published: true, width: published.width, height: published.height, closed: true },
      beforeDecode: { closed: true, decodeCalls: events.filter(event => event.scenario === "beforeDecode" && event.name === "decodeStart").length, urlCreates: before.owned.size, publications: 0 },
      pendingClose: { decodeStarted: true, pendingAtClose, decodeSettled: observation.settled(), closeSettled: true,
        srcAttributeRemoved: events.filter(event => event.scenario === "pendingClose" && event.name === "clear").every(event => event.srcAttribute === null),
        publications: events.filter(event => event.scenario === "pendingClose" && event.name === "publish").length, outcome: observation.outcome() },
      urls: { created: 2, revoked: owned.filter(([, value]) => value.revokes === 1).length, unique: new Set(owned.map(([url]) => url)).size === owned.length, freshRevokedDecodeRejected: true },
      sourceUnchanged: false, events });
  }
  const png = fixtures.find(fixture => fixture.family === "png"); requireProof(png, "PNG positive fixture exists.");
  const corruptEvents: EventRecord[] = [];
  const recovery = observedSession(new Map([["corrupt.png", corrupt], ["recovery.png", png]]), corruptEvents);
  const bad = await errorResult(recovery.session.show(recovery.intent("corrupt.png")));
  requireProof(bad instanceof DOMException && bad.name === "EncodingError", "Corrupt admitted PNG must produce an actual native decode error.");
  await recovery.session.show(recovery.intent("recovery.png")); await recovery.close(); requireProof(allRevoked(recovery), "Corrupt/recovery URLs revoked once.");

  const latestEvents: EventRecord[] = [], latest = observedSession(new Map([["A.png", png], ["B.png", png], ["C.png", png]]), latestEvents), admission = started(latest);
  const a = errorResult(latest.session.show(latest.intent("A.png"))); const observation = await admission;
  requireProof(!observation.settled(), "Latest-intent control begins at an observed pending native Promise.");
  const b = errorResult(latest.session.show(latest.intent("B.png"))), c = latest.session.show(latest.intent("C.png"));
  void c.catch(() => {}); // Preserve rejection for await below without an early unhandled event.
  requireProof(await a instanceof Error && await b instanceof Error, "Superseded A/B do not publish success."); await c; await latest.close();
  const reads = latestEvents.filter(event => event.name === "readStart"), aID = reads[0]?.id, cID = reads[1]?.id;
  requireProof(reads.length === 2 && reads[0].path === "A.png" && reads[1].path === "C.png", "Only A and latest C read.");
  const aSettled = latestEvents.find(event => event.name === "decodeSettled" && event.id === aID);
  requireProof(aSettled && aSettled.seq < reads[1].seq && allRevoked(latest), "A actually settled before C admission; URLs revoked once.");
  return { families, controls: {
    corruptPNG: { path: corrupt.path, mime: corrupt.mime, bytes: corrupt.bytes.length, sha256: corrupt.sha256, headerAdmitted: true, rejected: true, recovered: true, closed: true, events: corruptEvents },
    latest: { readPaths: reads.map(event => event.path), aSettledBeforeCRead: aSettled.seq < reads[1].seq,
      obsoletePublications: latestEvents.filter(event => event.name === "publish" && event.id !== cID).length, closed: true, urlsRevokedOnce: allRevoked(latest), events: latestEvents },
  } };
}

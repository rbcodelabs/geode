import { decodeQrPixels } from "./qr";
import { INVITATION_PREFIX } from "../../shared/pairing/invitation";

/**
 * Where a pairing invitation comes from. The camera is one implementation; the paste box is another (it needs no scanner);
 * a native scanner can replace the camera one later without touching the flow (docs/design/mobile-qr-pairing.md).
 */
export interface PairingScanner {
  /** Resolves with the first decoded text that looks like an invitation; rejects on abort, denial or no camera. The text is untrusted. */
  scan(signal: AbortSignal, preview: (video: HTMLVideoElement) => void): Promise<string>;
}

export class ScannerError extends Error {
  constructor(readonly reason: "unavailable" | "denied" | "aborted", message: string) { super(message); this.name = "ScannerError"; }
}

/** `getUserMedia` + jsQR. Returns null where there is no camera API (the caller then offers paste only). */
export function createCameraScanner(): PairingScanner | null {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return null;
  return {
    async scan(signal, preview) {
      if (signal.aborted) throw new ScannerError("aborted", "Scanning was cancelled.");
      let stream: MediaStream;
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }); }
      catch (error) {
        const name = (error as { name?: string })?.name;
        throw name === "NotAllowedError" || name === "SecurityError" ? new ScannerError("denied", "Camera access was denied. Allow it in Settings, or paste the code instead.") : new ScannerError("unavailable", "No camera is available. Paste the code instead.");
      }
      const video = document.createElement("video"); video.muted = true; video.playsInline = true; video.setAttribute("playsinline", ""); video.srcObject = stream;
      const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true });
      try {
        await video.play(); preview(video);
        return await new Promise<string>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stop = () => { if (timer) clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
          const onAbort = () => { stop(); reject(new ScannerError("aborted", "Scanning was cancelled.")); };
          signal.addEventListener("abort", onAbort, { once: true });
          const tick = () => {
            if (video.videoWidth && context) {
              const scale = Math.min(1, 640 / video.videoWidth); canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
              context.drawImage(video, 0, 0, canvas.width, canvas.height);
              const text = decodeQrPixels(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
              if (text && text.startsWith(INVITATION_PREFIX.slice(0, 10))) { stop(); resolve(text); return; }
            }
            timer = setTimeout(tick, 120);
          };
          tick();
        });
      } finally { for (const track of stream.getTracks()) track.stop(); video.srcObject = null; }
    },
  };
}

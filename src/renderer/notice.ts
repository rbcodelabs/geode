export type NoticeMessage = string | DocumentFragment;

export interface DismissibleNotice {
  noticeEl: HTMLElement;
  setMessage(message: NoticeMessage): void;
  hide(): void;
}

const INTERACTIVE_SELECTOR =
  "a, button, input, select, textarea, summary, [contenteditable='true'], [role='button'], [role='link']";

export function createDismissibleNotice(message: NoticeMessage, duration = 4000): DismissibleNotice {
  let host = document.querySelector(".notice-container") as HTMLElement | null;
  if (!host) {
    host = document.createElement("div");
    host.className = "notice-container";
    document.body.appendChild(host);
  }

  const noticeEl = document.createElement("div");
  noticeEl.className = "notice";
  noticeEl.setAttribute("role", "status");

  const contentEl = document.createElement("div");
  contentEl.className = "notice-content";
  noticeEl.appendChild(contentEl);

  const closeButton = document.createElement("button");
  closeButton.className = "notice-close-button";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Dismiss notification");
  closeButton.textContent = "×";
  noticeEl.appendChild(closeButton);

  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const hide = () => {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    noticeEl.remove();
  };
  const setMessage = (nextMessage: NoticeMessage) => {
    contentEl.replaceChildren();
    if (typeof nextMessage === "string") contentEl.textContent = nextMessage;
    else contentEl.appendChild(nextMessage);
  };

  closeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    hide();
  });
  noticeEl.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) return;
    hide();
  });

  setMessage(message);
  host.appendChild(noticeEl);
  if (duration > 0) hideTimer = setTimeout(hide, duration);

  return { noticeEl, setMessage, hide };
}

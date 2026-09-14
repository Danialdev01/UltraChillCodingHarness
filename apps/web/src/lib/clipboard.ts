/**
 * Putting text on the clipboard, wherever the app happens to be served from.
 *
 * `navigator.clipboard` exists only in a secure context: HTTPS, or localhost.
 * This harness is routinely opened at `http://<some-machine>:3000` from
 * another device on the network, and there the API is simply not there --
 * so a copy button that only called it would be dead on exactly the setup
 * this project documents.
 *
 * The fallback is the old `execCommand` route. It is deprecated and it is
 * still the only thing that works on a plain-HTTP origin, which is the whole
 * reason it is here.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied permission, or a non-secure context that advertises the API
    // anyway. Either way there is still the fallback below.
  }

  return legacyCopy(text);
}

/**
 * The pre-Clipboard-API copy: select a hidden textarea, ask the document to
 * copy the selection, put it back.
 *
 * The element has to be in the document and selectable, so it is positioned
 * off-screen rather than hidden -- `display: none` cannot hold a selection.
 * `readOnly` keeps a mobile keyboard from opening for the instant it exists.
 */
function legacyCopy(text: string): boolean {
  const document = globalThis.document;
  if (!document?.body) return false;

  const holder = document.createElement("textarea");
  holder.value = text;
  holder.readOnly = true;
  holder.setAttribute("aria-hidden", "true");
  holder.style.position = "fixed";
  holder.style.top = "-9999px";
  holder.style.opacity = "0";

  document.body.appendChild(holder);
  try {
    holder.select();
    holder.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    holder.remove();
  }
}

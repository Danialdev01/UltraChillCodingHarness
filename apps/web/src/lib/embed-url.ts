/**
 * Turning a pasted link into something a page can show inline.
 *
 * A handful of hosts have an embed form that differs from the page URL;
 * anything else over https is framed as it is and may or may not allow it.
 * Pure so the URL forms -- and the ones that must be refused -- are tested.
 */

export type EmbedProvider = "youtube" | "vimeo" | "loom" | "figma" | "codepen" | "generic";

export interface EmbedTarget {
  provider: EmbedProvider;
  /** What goes in the iframe. */
  src: string;
  /** What was pasted, for the link under the frame. */
  original: string;
}

const YOUTUBE_ID = /^[\w-]{11}$/;

export function classifyEmbedUrl(input: string): EmbedTarget | null {
  const original = input.trim();
  let url: URL;
  try {
    url = new URL(original);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^www\.|^m\./, "");

  const youtube = youtubeId(url, host);
  if (youtube) {
    const start = youtubeStart(url.searchParams.get("t"));
    const query = start ? `?start=${start}` : "";
    return {
      provider: "youtube",
      src: `https://www.youtube-nocookie.com/embed/${youtube}${query}`,
      original,
    };
  }

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = url.pathname.match(/\/(?:video\/)?(\d+)/)?.[1];
    if (id) return { provider: "vimeo", src: `https://player.vimeo.com/video/${id}`, original };
  }

  if (host === "loom.com") {
    const id = url.pathname.match(/\/(?:share|embed)\/([a-f0-9]{32})/)?.[1];
    if (id) return { provider: "loom", src: `https://www.loom.com/embed/${id}`, original };
  }

  if (host === "figma.com" && /^\/(file|design|proto|board)\//.test(url.pathname)) {
    return {
      provider: "figma",
      src: `https://www.figma.com/embed?embed_host=ucch&url=${encodeURIComponent(original)}`,
      original,
    };
  }

  if (host === "codepen.io") {
    const match = url.pathname.match(/^\/([^/]+)\/(?:pen|embed)\/([^/]+)/);
    if (match) {
      return {
        provider: "codepen",
        src: `https://codepen.io/${match[1]}/embed/${match[2]}?default-tab=result`,
        original,
      };
    }
  }

  if (url.protocol !== "https:") return null;
  return { provider: "generic", src: original, original };
}

/** Whether the text is one link and nothing else, as a paste of a URL is. */
export function isBareUrl(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text.trim());
}

function youtubeId(url: URL, host: string): string | null {
  let id: string | null | undefined;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else id = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?]+)/)?.[1];
  }
  return id && YOUTUBE_ID.test(id) ? id : null;
}

/** `t=1h2m3s`, `t=90s` or `t=90`, as seconds; nothing for anything else. */
function youtubeStart(t: string | null): number {
  if (!t) return 0;
  if (/^\d+s?$/.test(t)) return Number.parseInt(t, 10);
  const match = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match) return 0;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

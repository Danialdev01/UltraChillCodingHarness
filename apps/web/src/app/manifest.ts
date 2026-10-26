import type { MetadataRoute } from "next";

import icon192 from "./icon-192.png";
import icon512 from "./icon-512.png";
import iconMaskable512 from "./icon-maskable-512.png";

/**
 * What a browser needs to install the app: `/manifest.webmanifest`, linked
 * from every page by Next.
 *
 * The icons are imported rather than placed beside it: Next serves only its
 * own `icon` / `apple-icon` names from this folder, and an import puts each
 * one under `/_next/static/media` with a content hash, cached for good like
 * the rest of the build. They are the apple icon's tile (`apple-icon.png`)
 * at the sizes Chrome asks for; the maskable one keeps the mark inside the
 * circle a launcher may crop to.
 *
 * The colours are the light theme's `--background`, which is what the
 * window shows before the first paint.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ultra Chill Coding Harness",
    short_name: "UCCH",
    description: "Ultra Chill Coding Harness",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fafcff",
    theme_color: "#fafcff",
    icons: [
      { src: icon192.src, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: icon512.src, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: iconMaskable512.src, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

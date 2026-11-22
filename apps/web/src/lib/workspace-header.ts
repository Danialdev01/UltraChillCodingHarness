/**
 * The request header the app shell reads the open workspace from.
 *
 * The shell is the `(app)` layout, and a layout is not given its children's
 * params, so `proxy.ts` copies the workspace hash out of `/{ws}/…`
 * into this header for it. Its own module so the proxy bundle does not
 * pull in anything else.
 */
export const WORKSPACE_HEADER = "x-ucch-ws";

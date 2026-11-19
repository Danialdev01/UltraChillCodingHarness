import { TerminalWorkspace } from "@/components/terminal/terminal-workspace";

/**
 * The Terminal section: shells on the workspace's SSH servers, in tabs and
 * splits, with their files and an agent that works on them. Everything is
 * the client's -- the servers list and the shells -- so the page has
 * nothing to wait for on the server.
 */
export default function TerminalPage() {
  return <TerminalWorkspace />;
}

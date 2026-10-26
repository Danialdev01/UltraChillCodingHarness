import { DEFAULT_DB_PORTS } from "@ucch/protocol/plain";
import type { DatabaseEngine } from "@ucch/protocol";

/**
 * A connection URL as hosting panels print it, taken apart into fields.
 *
 * Deliberately not `new URL()`: managed hosts hand out usernames like
 * `person@example.com`, unescaped, and the URL parser reads everything after
 * the first `@` as the host. The credentials end at the *last* `@`, the
 * username at the *first* `:` (a password may hold a colon), and percent
 * escapes are honoured so a properly encoded URL parses the same way.
 */
export interface ParsedDatabaseUrl {
  engine: DatabaseEngine;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string | undefined;
}

const SCHEMES: Record<string, DatabaseEngine> = {
  mysql: "mysql",
  mariadb: "mysql",
  postgres: "postgresql",
  postgresql: "postgresql",
};

export function parseDatabaseUrl(raw: string): ParsedDatabaseUrl | { error: string } {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is.exec(raw.trim());
  if (!match) return { error: "Expected a URL like mysql://user:password@host:3306/db" };
  const engine = SCHEMES[match[1]!.toLowerCase()];
  if (!engine) return { error: `Unsupported scheme "${match[1]}"; use mysql:// or postgresql://` };

  const rest = match[2]!;
  const at = rest.lastIndexOf("@");
  const userinfo = at === -1 ? "" : rest.slice(0, at);
  let location = at === -1 ? rest : rest.slice(at + 1);

  const colon = userinfo.indexOf(":");
  const username = decode(colon === -1 ? userinfo : userinfo.slice(0, colon));
  const password = decode(colon === -1 ? "" : userinfo.slice(colon + 1));

  // Query and fragment carry driver options this form does not offer.
  location = location.replace(/[?#].*$/s, "");
  const slash = location.indexOf("/");
  const hostport = slash === -1 ? location : location.slice(0, slash);
  const path = slash === -1 ? "" : location.slice(slash + 1);
  const database = decode(path) || undefined;

  let host: string;
  let portText: string | undefined;
  if (hostport.startsWith("[")) {
    const close = hostport.indexOf("]");
    if (close === -1) return { error: "Unterminated IPv6 address" };
    host = hostport.slice(1, close);
    const after = hostport.slice(close + 1);
    if (after && !after.startsWith(":")) return { error: "Unexpected text after the IPv6 address" };
    portText = after ? after.slice(1) : undefined;
  } else {
    const lastColon = hostport.lastIndexOf(":");
    host = lastColon === -1 ? hostport : hostport.slice(0, lastColon);
    portText = lastColon === -1 ? undefined : hostport.slice(lastColon + 1);
  }
  if (!host) return { error: "The URL has no host" };

  let port = DEFAULT_DB_PORTS[engine];
  if (portText !== undefined) {
    if (!/^\d{1,5}$/.test(portText)) return { error: `"${portText}" is not a port number` };
    port = Number(portText);
    if (port < 1 || port > 65535) return { error: `Port ${port} is out of range` };
  }

  return { engine, host, port, username, password, database };
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

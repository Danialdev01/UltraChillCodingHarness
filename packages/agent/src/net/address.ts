import { BlockList, isIP } from "node:net";

/**
 * What counts as a public address, decided on the address itself rather than
 * on how it was written: `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same
 * address, and so is what a NAT64 or 6to4 prefix carries inside it.
 */

/** The 16-bit groups of an IPv6 address, or null when it is not one. */
function groupsOf(address: string): number[] | null {
  let text = address.split("%")[0]!.toLowerCase();
  if (isIP(text) !== 6) return null;
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => parseInt(group, 16)));
  const left = parse(head);
  if (tail === undefined) return left;
  const right = parse(tail);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

const dotted = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

/**
 * The IPv4 address an IPv6 one carries, or null: mapped (`::ffff:0:0/96`),
 * translated (`::ffff:0:0:0/96`), compatible (`::/96`), NAT64
 * (`64:ff9b::/96`) and 6to4 (`2002::/16`).
 */
function embeddedV4(groups: number[]): string | null {
  const [a, b, c, d, e, f, g, h] = groups as [number, number, number, number, number, number, number, number];
  if (a === 0x2002) return dotted(b, c);
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return dotted(g, h);
  if (a === 0 && b === 0 && c === 0 && d === 0) {
    if (e === 0 && f === 0xffff) return dotted(g, h);
    if (e === 0xffff && f === 0) return dotted(g, h);
    // `::` and `::1` are addresses of their own, handled as IPv6.
    if (e === 0 && f === 0 && (g !== 0 || h > 1)) return dotted(g, h);
  }
  return null;
}

const V4 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, and the cloud metadata address
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 3], // multicast and reserved
] as const) {
  V4.addSubnet(net, bits, "ipv4");
}

const V6 = new BlockList();
for (const [net, bits] of [
  ["::", 127], // unspecified and loopback
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard
  ["2001::", 23], // protocol assignments, Teredo among them
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local, deprecated
  ["ff00::", 8], // multicast
] as const) {
  V6.addSubnet(net, bits, "ipv6");
}

/**
 * Whether an address is anything but a public one: loopback, link-local,
 * private, carrier-grade NAT, multicast, reserved -- or not an address.
 */
export function isBlocked(address: string): boolean {
  if (isIP(address) === 4) return V4.check(address, "ipv4");
  const groups = groupsOf(address);
  if (!groups) return true;
  const inner = embeddedV4(groups);
  if (inner) return V4.check(inner, "ipv4");
  return V6.check(address.split("%")[0]!, "ipv6");
}

/** Whether connecting to an address reaches this machine. */
export function isLoopbackAddress(address: string): boolean {
  const groups = isIP(address) === 6 ? groupsOf(address) : null;
  const v4 = groups ? embeddedV4(groups) : isIP(address) === 4 ? address : null;
  // The unspecified address connects to loopback on Linux.
  if (v4) return v4.startsWith("127.") || v4 === "0.0.0.0";
  return Boolean(groups && groups.slice(0, 7).every((group) => group === 0) && groups[7]! <= 1);
}

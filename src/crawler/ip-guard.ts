import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * SSRF protection: addresses the crawler must never connect to (the office
 * network, the machine itself, cloud metadata services, reserved ranges).
 */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 (can point at private IPv4)
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local (private)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

/** true when connecting to this IP address is not allowed. Invalid input is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return BLOCKED.check(ip, 'ipv4');
  if (version === 6) {
    // IPv4-mapped IPv6 ("::ffff:10.0.0.1") is checked as the IPv4 address inside it.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped?.[1]) return BLOCKED.check(mapped[1], 'ipv4');
    return BLOCKED.check(ip, 'ipv6');
  }
  return true;
}

export class BlockedAddressError extends Error {
  readonly code = 'BLOCKED_ADDRESS';
  constructor(hostname: string) {
    super(`${hostname} resolves only to private or reserved addresses`);
    this.name = 'BlockedAddressError';
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * Drop-in replacement for dns.lookup used by the HTTP request itself: the IP
 * that is checked is exactly the IP that is connected to, so a DNS answer that
 * changes between "check" and "connect" (DNS rebinding) cannot slip through.
 */
export function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback,
): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err, '');
      return;
    }
    const safe = addresses.filter((a) => !isBlockedAddress(a.address));
    const first = safe[0];
    if (!first) {
      callback(new BlockedAddressError(hostname), '');
      return;
    }
    if (options.all) callback(null, safe);
    else callback(null, first.address, first.family);
  });
}
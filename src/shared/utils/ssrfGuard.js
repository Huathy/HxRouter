// SSRF guard: block internal/private/metadata targets for server-side fetch.
import dns from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";

const BLOCKED_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);
const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost"];
const PUBLIC_PROTOCOLS = new Set(["http:", "https:"]);

function ipv4ToInt(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

const BLOCKED_V4_RANGES = [
  [0, 8], [ipv4ToInt("10.0.0.0"), 8], [ipv4ToInt("127.0.0.0"), 8],
  [ipv4ToInt("169.254.0.0"), 16], [ipv4ToInt("172.16.0.0"), 12],
  [ipv4ToInt("192.168.0.0"), 16], [ipv4ToInt("192.0.0.0"), 24], [ipv4ToInt("192.0.2.0"), 24], [ipv4ToInt("192.88.99.0"), 24], [ipv4ToInt("198.18.0.0"), 15], [ipv4ToInt("198.51.100.0"), 24], [ipv4ToInt("203.0.113.0"), 24], [ipv4ToInt("100.64.0.0"), 10], [ipv4ToInt("224.0.0.0"), 4], [ipv4ToInt("240.0.0.0"), 4],
];

function isBlockedIpv4(host) {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
  });
}

function isBlockedIpv6(host) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  if (h === "::1" || h === "::" || h.startsWith("::ffff:") || h.startsWith("::")) return true;
  if (h.startsWith("::") && h.includes(".")) return true;
  const firstHextet = Number.parseInt(h.split(":")[0] || "0", 16);
  if ((firstHextet & 0xffc0) === 0xfec0) return true;
  if ((firstHextet & 0xff00) === 0xff00) return true;
  if (h.startsWith("fe80:") || (firstHextet & 0xfe00) === 0xfc00) return true;
  if (h.startsWith("2001:db8:") || h.startsWith("2001:2:") || h.startsWith("2001:10:")) return true;
  return false;
}

function assertPublicLiteral(host) {
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new Error("Blocked URL: internal host");
  }
  if (isBlockedIpv4(host) || (host.includes(":") && isBlockedIpv6(host))) {
    throw new Error("Blocked URL: private IP");
  }
}

export async function assertPublicUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  if (!PUBLIC_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Blocked URL: unsupported target");
  }
  assertPublicLiteral(host);
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("Blocked URL: DNS lookup failed");
  }
  if (!addresses.length || addresses.some(({ address }) => isBlockedIpv4(address) || (address.includes(":") && isBlockedIpv6(address)))) {
    throw new Error("Blocked URL: private IP");
  }
  return { url: parsed, addresses };
}

export function createPinnedLookup(address) {
  return (_host, options, callback) => {
    if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  };
}

export async function guardedFetch(rawUrl, options = {}) {
  const { url, addresses } = await assertPublicUrl(rawUrl);
  const address = addresses[0];
  const agent = new Agent({ connect: { lookup: createPinnedLookup(address) } });
  try {
    return await undiciFetch(url, { ...options, dispatcher: agent });
  } finally {
    await agent.close();
  }
}

export async function guardedFetchWithConsumer(rawUrl, options, consume) {
  const { url, addresses } = await assertPublicUrl(rawUrl);
  const address = addresses[0];
  const agent = new Agent({ connect: { lookup: createPinnedLookup(address) } });
  try {
    const response = await undiciFetch(url, { ...options, dispatcher: agent });
    return await consume(response);
  } finally {
    await agent.close();
  }
}


// Source embedded in edge/serverless relays; keep it dependency-free.
export const RELAY_TARGET_GUARD_SOURCE = `function assertTrustedTarget(rawUrl) {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase();
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Blocked URL: unsupported target");
  }
  if (["localhost", "ip6-localhost", "ip6-loopback"].includes(host) ||
      host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".localhost")) {
    throw new Error("Blocked URL: internal host");
  }
  const ipv4 = host.split(".");
  if (ipv4.length === 4 && ipv4.every((part) => /^\\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const ip = ipv4.reduce((value, part) => value * 256 + Number(part), 0) >>> 0;
    const blocked = [[0, 8], [167772160, 8], [2130706432, 8], [2851995648, 16], [2852039168, 12], [2886729728, 12], [3232235520, 16], [3221225472, 24], [3221225984, 24], [3227017984, 24], [3323068416, 15], [3325256704, 24], [3405803776, 24], [1681915904, 10], [3758096384, 4], [4026531840, 4]];
    if (blocked.some(([base, bits]) => (ip & ((0xffffffff << (32 - bits)) >>> 0)) === (base & ((0xffffffff << (32 - bits)) >>> 0)))) {
      throw new Error("Blocked URL: private IP");
    }
  }
  const ipv6 = host.replace(/^\\[|\\]$/g, "").toLowerCase();
  const firstHextet = parseInt(ipv6.split(":")[0] || "0", 16);
  if (ipv6.startsWith("::") || (firstHextet & 0xffc0) === 0xfec0 || (firstHextet & 0xff00) === 0xff00 || ipv6.startsWith("fe80:") || (firstHextet & 0xfe00) === 0xfc00 || ipv6.startsWith("2001:db8:") || ipv6.startsWith("2001:2:") || ipv6.startsWith("2001:10:")) {
    throw new Error("Blocked URL: private IP");
  }
}`;

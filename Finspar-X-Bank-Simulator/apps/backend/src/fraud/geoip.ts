import geoip from 'geoip-lite';
import axios from 'axios';
import { env } from '../common/env';

/**
 * Offline IP -> geo resolution for the fraud gateway. Uses the bundled MaxMind
 * GeoLite2 data (in-process, no network call, sub-millisecond) so it is safe on
 * the login/payment path.
 *
 * The client's real country is what feeds the model's `f_user_new_country`
 * signal — a login/payment from a country the user has never used is a genuine
 * account-takeover signal (a VPN's exit country flowing through is the feature
 * working, not a bug). Private/loopback IPs (dev, unproxied) resolve to null.
 *
 * DEV fallback (env.geo.devUsePublicIp): browser->localhost is loopback, so a
 * VPN is invisible to req.ip. When enabled, a private/loopback IP falls back to
 * the machine's PUBLIC egress IP (which DOES traverse the VPN), so local testing
 * shows your real / VPN country. Off in production.
 */

/** Normalise Express's ip (may be IPv4-mapped IPv6 like `::ffff:1.2.3.4`). */
function normalizeIp(ip?: string): string | undefined {
  if (!ip) return undefined;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export interface GeoResult {
  country?: string; // ISO alpha-2
  lat?: number;
  lon?: number;
}

function toGeo(ip: string): GeoResult {
  const hit = geoip.lookup(ip);
  return hit ? { country: hit.country, lat: hit.ll?.[0], lon: hit.ll?.[1] } : {};
}

// --- DEV public-IP cache (only used when env.geo.devUsePublicIp) --------------
let cachedPublicGeo: GeoResult = {};
let lastFetch = 0;
const PUBLIC_IP_TTL = 60_000; // 60s so a VPN switch reflects quickly

async function refreshPublicGeo(): Promise<void> {
  lastFetch = Date.now(); // set first so concurrent requests don't all fetch
  try {
    const { data } = await axios.get<{ ip: string }>('https://api.ipify.org?format=json', {
      timeout: 3000,
    });
    if (data?.ip) cachedPublicGeo = toGeo(data.ip);
  } catch {
    // Offline / blocked — keep whatever we had; dev fallback is best-effort.
  }
}

// Warm the cache at startup when the dev fallback is on.
if (env.geo.devUsePublicIp) void refreshPublicGeo();

/** Resolve country + lat/lon from an IP. Returns {} for private/loopback/unknown
 *  unless the dev public-IP fallback is enabled. */
export function geoFromIp(ip?: string): GeoResult {
  const clean = normalizeIp(ip);
  if (clean) {
    const geo = toGeo(clean);
    if (geo.country) return geo;
  }
  // Private/loopback/unknown -> DEV fallback to the public egress IP.
  if (env.geo.devUsePublicIp) {
    if (Date.now() - lastFetch > PUBLIC_IP_TTL) void refreshPublicGeo(); // refresh in bg
    return cachedPublicGeo;
  }
  return {};
}

/** Convenience: just the country (ISO alpha-2), or undefined. */
export function countryFromIp(ip?: string): string | undefined {
  return geoFromIp(ip).country;
}

// --- Mock-VPN support (login-page country selector, dev only) -----------------
// Representative capital-ish coordinates for the selectable countries, so a
// mocked country also carries plausible geo_lat/lon to the model.
const COUNTRY_COORDS: Record<string, [number, number]> = {
  IN: [20.5937, 78.9629],
  US: [37.0902, -95.7129],
  GB: [51.5074, -0.1278],
  NL: [52.3676, 4.9041],
  SG: [1.3521, 103.8198],
  AE: [24.4539, 54.3773],
  AU: [-33.8688, 151.2093],
  DE: [52.52, 13.405],
  JP: [35.6762, 139.6503],
  FR: [48.8566, 2.3522],
  CA: [43.6532, -79.3832],
  RU: [55.7558, 37.6173],
};

/** Geo for an explicitly chosen country (mock VPN). */
export function geoForCountry(country: string): GeoResult {
  const code = country.toUpperCase();
  const ll = COUNTRY_COORDS[code];
  return ll ? { country: code, lat: ll[0], lon: ll[1] } : { country: code };
}

/**
 * Resolve the request geo: a mock-VPN country header wins when the dev flag
 * allows it, otherwise fall back to geo-IP on the client address.
 */
export function resolveGeo(ip?: string, mockCountry?: string): GeoResult {
  if (env.geo.allowMockCountry && mockCountry) return geoForCountry(mockCountry);
  return geoFromIp(ip);
}

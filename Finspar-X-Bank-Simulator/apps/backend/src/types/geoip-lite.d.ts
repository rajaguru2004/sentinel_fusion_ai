declare module 'geoip-lite' {
  export interface GeoLookup {
    range: [number, number];
    country: string; // ISO-3166 alpha-2, e.g. "IN", "SG"
    region: string;
    eu: '0' | '1';
    timezone: string;
    city: string;
    ll: [number, number]; // [latitude, longitude]
    metro: number;
    area: number;
  }
  export function lookup(ip: string): GeoLookup | null;
}

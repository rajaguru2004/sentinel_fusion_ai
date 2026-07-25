'use client';

import { Globe2, MapPin, PlaneTakeoff } from 'lucide-react';

export interface GeoPoint {
  country?: string | null;
  lat?: number | null;
  lon?: number | null;
  at?: string | null;
}

/** Home market — matches the backend's GEO_ALLOWED_COUNTRIES default. */
const HOME_COUNTRY = 'IN';
/** Fastest plausible sustained travel, including airport time. */
const MAX_KMH = 900;

interface Coord {
  lat: number;
  lon: number;
}

/** Great-circle distance in km. */
function haversineKm(a: Coord, b: Coord): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Impossible travel: could a human have covered this distance in this time?
 *
 * Returns null when it cannot be judged — missing coordinates, missing
 * timestamps, or a non-positive interval. Returning null rather than `false`
 * matters: "we could not check" and "we checked and it was fine" are different
 * claims, and only the second should ever reassure an analyst.
 */
export function impossibleTravel(
  from: GeoPoint,
  to: GeoPoint,
): { km: number; hours: number; impliedKmh: number } | null {
  if (from.lat == null || from.lon == null || to.lat == null || to.lon == null) return null;
  if (!from.at || !to.at) return null;

  const hours = (new Date(to.at).getTime() - new Date(from.at).getTime()) / 3_600_000;
  if (!Number.isFinite(hours) || hours <= 0) return null;

  const km = haversineKm(
    { lat: from.lat, lon: from.lon },
    { lat: to.lat, lon: to.lon },
  );
  const impliedKmh = km / hours;
  return impliedKmh > MAX_KMH ? { km, hours, impliedKmh } : null;
}

/**
 * Where the request came from (ENHANCEMENTS.md §5).
 *
 * `country / geoLat / geoLon` are already resolved on every event by the fraud
 * gateway, but nothing rendered them. A coordinate pair and a foreign-country
 * flag are the cheapest high-signal context an analyst can get on a verdict.
 *
 * `previous` is optional; when supplied, the two points are checked for
 * impossible travel — the classic account-takeover tell.
 */
export function GeoPanel({ current, previous }: { current: GeoPoint; previous?: GeoPoint }) {
  const hasPoint = current.lat != null && current.lon != null;
  if (!current.country && !hasPoint) return null;

  const foreign = !!current.country && current.country.toUpperCase() !== HOME_COUNTRY;
  const travel = previous ? impossibleTravel(previous, current) : null;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-text">Where this came from</p>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-text">
          <Globe2 className="h-3.5 w-3.5 text-text-muted" />
          {current.country ?? 'unknown country'}
        </span>

        {hasPoint && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 font-mono text-text">
            <MapPin className="h-3.5 w-3.5 text-text-muted" />
            {current.lat!.toFixed(4)}, {current.lon!.toFixed(4)}
          </span>
        )}

        {foreign && (
          <span className="rounded-full border border-risk-medium/30 bg-risk-medium/10 px-2.5 py-1 text-risk-medium">
            outside the bank&apos;s home market — policy floors this to at least MEDIUM
          </span>
        )}
      </div>

      {travel && (
        <div className="flex items-start gap-2 rounded-[var(--radius-input)] border border-risk-critical/30 bg-risk-critical/10 px-3 py-2 text-xs text-risk-critical">
          <PlaneTakeoff className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-semibold">Impossible travel.</span>{' '}
            {Math.round(travel.km).toLocaleString()} km in {travel.hours.toFixed(1)} h implies{' '}
            {Math.round(travel.impliedKmh).toLocaleString()} km/h — faster than any commercial
            flight. The two sessions cannot both be the same person.
          </span>
        </div>
      )}
    </div>
  );
}

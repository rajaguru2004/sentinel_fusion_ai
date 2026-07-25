/**
 * Money & date formatting. Indian grouping everywhere: ₹72,201.96, ₹4,60,000.00.
 * Never ₹460,000.00. The ONE place amounts are formatted — no ad-hoc formatting.
 * BANK_SIMULATOR_SPEC.md §11.
 *
 * Amounts cross the wire as BigInt paise serialised to strings. Parse with
 * paiseToRupees before displaying.
 */

const inrFormatter = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** paise (string | bigint | number) -> rupees number. 7220196 -> 72201.96 */
export function paiseToRupees(paise: string | bigint | number): number {
  return Number(BigInt(paise)) / 100;
}

/** Format rupees with the ₹ symbol and Indian grouping. 460000 -> "₹4,60,000.00" */
export function formatINR(rupees: number): string {
  return `₹${inrFormatter.format(rupees)}`;
}

/** Convenience: paise straight to a formatted ₹ string. */
export function formatPaise(paise: string | bigint | number): string {
  return formatINR(paiseToRupees(paise));
}

/** DD/MM/YYYY — the format used across every screen (§6). */
export function formatDateDMY(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** DD/MM/YYYY HH:MM — for "Last Login" style timestamps. */
export function formatDateTimeDMY(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${formatDateDMY(d)} ${hh}:${min}`;
}

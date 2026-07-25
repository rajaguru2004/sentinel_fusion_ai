let counter = 0;

/** Short, monotonic, collision-resistant within and across runs. */
export const uniqueSuffix = (): string =>
  `${Date.now().toString(36).toUpperCase().slice(-6)}${(counter++).toString(36).toUpperCase()}`;

/** Beneficiary.code — @MaxLength(20) and @@unique([customerId, code]). */
export const beneCode = (): string => `E2E${uniqueSuffix()}`.slice(0, 20);

/**
 * Payment.custRefNo — @MaxLength(35) and @@unique([customerId, custRefNo]).
 * The service's duplicate check excludes soft-deleted payments while the DB
 * constraint does not, so a reused ref surfaces as a raw Prisma P2002 rather
 * than a friendly 400. Always generate a fresh one.
 */
export const custRef = (tag: string): string => `E2E-${tag}-${uniqueSuffix()}`.slice(0, 35);

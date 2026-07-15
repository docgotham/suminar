// Suminar pilot limits — the TypeScript mirror of public.pilot_limits() in
// supabase/migrations. The database triggers are the enforcement point; this
// module is the single source the hosted layer, docs, and drift tests read,
// so a number changed in one place fails the suite until every surface agrees.

export const PILOT_LIMITS = {
  invocationsPerAccountPerDay: 200,
  invocationsPerAccountPerMonth: 2000,
  storageBytesPerAccount: 1_073_741_824,
  documentsPerAccount: 50,
  uploadMaxBytes: 268_435_456,
  activeInviteCodesPerIssuer: 10,
  waitlistMaxEntries: 10_000,
  activeSyndicationCodesPerGrantor: 10,
  activeSyndicationGrantsPerAgent: 25,
} as const;

// Every limit rejection raised by the database begins with this prefix; the
// hosted layer relays such messages verbatim as client-actionable rejections
// instead of opaque server errors.
export const PILOT_LIMIT_MESSAGE_PREFIX = "Suminar pilot limit:";

export function isPilotLimitMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && message.includes(PILOT_LIMIT_MESSAGE_PREFIX);
}

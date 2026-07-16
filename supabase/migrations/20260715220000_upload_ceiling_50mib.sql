-- Direct-to-Storage upload lands the single-upload ceiling on the real binding
-- limit. The browser now PUTs originals straight to Supabase Storage via a
-- signed URL, bypassing the ~4.5 MB Vercel function request-body limit — so the
-- true per-file cap is the artifacts bucket's 50 MiB object-size limit, not the
-- aspirational 256 MiB advertised while nothing over ~4.5 MB could be uploaded
-- at all. pilot_limits() is create-or-replace; only uploadMaxBytes moves.

create or replace function public.pilot_limits()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'invocationsPerAccountPerDay', 200,
    'invocationsPerAccountPerMonth', 2000,
    'storageBytesPerAccount', 1073741824,
    'documentsPerAccount', 50,
    'uploadMaxBytes', 52428800,
    'activeInviteCodesPerIssuer', 10,
    'waitlistMaxEntries', 10000,
    'activeSyndicationCodesPerGrantor', 10,
    'activeSyndicationGrantsPerAgent', 25
  );
$$;

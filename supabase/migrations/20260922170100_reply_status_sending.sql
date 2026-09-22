-- A reply that is on its way needs a state of its own, so that pressing send
-- twice cannot send twice.
--
-- The send path claims the draft by moving it to 'sending' and only proceeds
-- if that move was the one that took it. A second press finds nothing left to
-- claim and stops. Postgres will not let a new enum value be used in the same
-- transaction that adds it, which is why this is its own migration.
alter type public.reply_status add value 'sending' before 'sent';

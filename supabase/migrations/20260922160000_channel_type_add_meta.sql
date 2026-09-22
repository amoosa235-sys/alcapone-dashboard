-- Instagram and Facebook were not in the v1 plan, but the channels page now
-- takes credentials for them, so the enum has to name them. Nothing reads
-- these values yet: no integration is built behind either one.
--
-- Adding enum values is its own migration because a new value cannot be used
-- in the same transaction that creates it.

alter type public.channel_type add value if not exists 'instagram';
alter type public.channel_type add value if not exists 'facebook';

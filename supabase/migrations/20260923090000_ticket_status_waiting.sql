-- A ticket the team has answered is not "being worked on" any more: the ball
-- is in the customer's court. 'waiting' says so, and a reply from the
-- customer moves the ticket back to 'pending'.
--
-- Adding an enum value is its own migration because a new value cannot be
-- used in the same transaction that creates it.
alter type public.ticket_status add value if not exists 'waiting' before 'closed';

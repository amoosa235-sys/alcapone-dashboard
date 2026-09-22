-- A reply in flight still has to be writable: the send path marks it sent
-- when the channel accepts it, and puts it back to draft with the reason when
-- the channel does not. The rule that matters is unchanged -- a row that has
-- reached 'sent' can never be edited again, so nothing a customer has read
-- can be quietly reworded.
drop policy ticket_replies_update_draft on public.ticket_replies;

create policy ticket_replies_update_unsent
  on public.ticket_replies for update to authenticated
  using (
    tenant_id in (select private.current_tenant_ids())
    and status in ('draft', 'sending', 'failed')
  )
  with check (tenant_id in (select private.current_tenant_ids()));

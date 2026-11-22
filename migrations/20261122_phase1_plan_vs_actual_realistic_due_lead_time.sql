-- Phase 1 of the decision-center roadmap. Nothing here rewrites existing invoices, lines or purchases.
--  1) realistic deadline for NEW invoices (owner chose "write it automatically")
--  2) plan vs actual (read-only report)
--  3) supplier lead time: optional "ordered on" date on a supplier invoice

-- ---------- 1) realistic deadline ----------
-- team output = sum of each stock worker's average pieces per full working day (last 14 days;
-- workers with 2+ days of history who worked in the last 7 days).
create or replace function public.team_rate()
returns numeric language sql stable security definer set search_path to 'public' as $function$
  select sum(pd) from (
    select d.worker_id, avg(d.pcs) pd
    from (select lt.worker_id, (lt.done_at at time zone 'Africa/Cairo')::date dy, sum(lt.qty) pcs
          from line_timing lt
          where lt.undone_at is null and lt.done_at >= now() - interval '14 days'
            and (lt.done_at at time zone 'Africa/Cairo')::date < (now() at time zone 'Africa/Cairo')::date
          group by 1, 2) d
    join profiles p on p.id = d.worker_id and p.active and p.role = 'stock'
    group by d.worker_id
    having count(*) >= 2 and max(d.dy) >= (now() at time zone 'Africa/Cairo')::date - 7) r
$function$;

-- finish date if the open orders are worked first-come-first-served at the team's real output.
-- Never earlier than the standard rule (invoice date + 4 working days). NULL when there is no output history.
create or replace function public.realistic_due(p_invoice uuid)
returns date language plpgsql stable security definer set search_path to 'public' as $function$
declare i record; rate numeric; ahead numeric; mine numeric; n int; st date; std date;
begin
  select id, date, created_at into i from invoices where id = p_invoice;
  if not found then return null; end if;
  std := add_work_days(i.date, 4);
  rate := team_rate();
  if rate is null or rate <= 0 then return null; end if;
  select coalesce(sum(l.qty), 0) into mine from invoice_lines l where l.invoice_id = p_invoice and l.active and l.done_at is null;
  select coalesce(sum(l.qty), 0) into ahead
    from invoice_lines l join invoices o on o.id = l.invoice_id
    where l.active and l.done_at is null and o.id <> p_invoice and o.created_at < i.created_at
      and o.deleted_at is null and o.fulfilled_at is null and o.cancelled_by is null;
  n := greatest(1, ceil((ahead + mine) / rate)::int);
  st := (now() at time zone 'Africa/Cairo')::date;
  if extract(dow from st) = 5 then st := st + 1; end if;
  return greatest(std, add_work_days(st, n - 1));
end $function$;

-- the automatic deadline keeps following the invoice date, now with the realistic date as a floor
create or replace function public.trg_invoice_due()
returns trigger language plpgsql set search_path to 'public' as $function$
declare d date;
begin
  if tg_op = 'INSERT' then
    if new.due_date is null then new.due_date := add_work_days(new.date, 4); new.due_manual := false; end if;
  elsif new.date is distinct from old.date and not new.due_manual and new.due_date is not distinct from old.due_date then
    new.due_date := add_work_days(new.date, 4);
    begin d := realistic_due(new.id); if d is not null and d > new.due_date then new.due_date := d; end if;
    exception when others then null; end;
  end if;
  return new;
end $function$;

-- runs at the END of the saving transaction (the lines exist by then). It can never block saving an invoice.
create or replace function public.trg_invoice_due_real()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare d date;
begin
  begin
    d := realistic_due(new.id);
    if d is not null then
      update invoices set due_date = d where id = new.id and not due_manual and deleted_at is null and due_date is distinct from d;
    end if;
  exception when others then null;
  end;
  return null;
end $function$;
drop trigger if exists invoice_due_real on public.invoices;
create constraint trigger invoice_due_real after insert on public.invoices
  deferrable initially deferred for each row execute function public.trg_invoice_due_real();

revoke all on function public.team_rate() from public, anon, authenticated;
revoke all on function public.realistic_due(uuid) from public, anon, authenticated;

-- ---------- 2) plan vs actual (owner only, read only) ----------
create or replace function public.plan_vs_actual(p_days integer default 14)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare res jsonb; d0 date := (now() at time zone 'Africa/Cairo')::date - greatest(1, least(60, p_days)) + 1;
begin
  if my_role() is distinct from 'owner' then raise exception 'not_allowed'; end if;
  with out_day as (   -- what each worker really finished each day
    select lt.worker_id, max(lt.worker_name) name, (lt.done_at at time zone 'Africa/Cairo')::date d, sum(lt.qty) pcs, count(*) ln
    from line_timing lt join profiles p on p.id = lt.worker_id and p.role = 'stock'
    where lt.undone_at is null and (lt.done_at at time zone 'Africa/Cairo')::date >= d0 group by 1, 3),
  pl as (             -- the last distribution sent to each worker on each day (replaced/cancelled ones excluded)
    select a.worker_id, a.worker_name name, (a.assigned_at at time zone 'Africa/Cairo')::date d, a.line_id, a.release_reason,
           il.qty, il.done_at, il.done_by, (il.done_at at time zone 'Africa/Cairo')::date dd
    from work_assignments a join invoice_lines il on il.id = a.line_id
    where (a.assigned_at at time zone 'Africa/Cairo')::date >= d0 and (a.released_at is null or a.release_reason = 'declined')),
  pw as (
    select worker_id, max(name) name, d, count(*) lines, sum(qty) pcs,
      coalesce(sum(qty) filter (where release_reason is null and done_by = worker_id and dd = d), 0) done_same_day,
      coalesce(sum(qty) filter (where release_reason is null and done_by = worker_id and dd > d), 0) done_later,
      coalesce(sum(qty) filter (where release_reason is null and done_at is not null and done_by is distinct from worker_id), 0) done_by_other,
      coalesce(sum(qty) filter (where release_reason = 'declined'), 0) declined,
      coalesce(sum(qty) filter (where release_reason is null and done_at is null), 0) still_open
    from pl group by worker_id, d)
  select jsonb_build_object(
    'from', d0,
    'output', (select coalesce(jsonb_agg(jsonb_build_object('d', d, 'pcs', pcs, 'lines', ln, 'workers', w) order by d), '[]')
               from (select d, sum(pcs) pcs, sum(ln) ln, count(*) w from out_day group by d) x),
    'plans', (select coalesce(jsonb_agg(jsonb_build_object('d', pw.d, 'worker', pw.worker_id, 'name', pw.name, 'lines', pw.lines, 'pcs', pw.pcs,
                 'done_same_day', pw.done_same_day, 'done_later', pw.done_later, 'done_by_other', pw.done_by_other, 'declined', pw.declined, 'still_open', pw.still_open,
                 'day_output', coalesce((select o.pcs from out_day o where o.worker_id = pw.worker_id and o.d = pw.d), 0)) order by pw.d desc, pw.name), '[]') from pw)
  ) into res;
  return res;
end $function$;
revoke all on function public.plan_vs_actual(integer) from public, anon;
grant execute on function public.plan_vs_actual(integer) to authenticated;

-- ---------- 3) supplier lead time ----------
alter table public.supplier_invoices add column if not exists ordered_at date;
create or replace function public.set_supplier_ordered(p_invoice uuid, p_date date)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare d date;
begin
  if my_role() is distinct from 'owner' then raise exception 'not_allowed'; end if;
  select date into d from supplier_invoices where id = p_invoice;
  if not found then raise exception 'not_found'; end if;
  if p_date is not null and p_date > d then raise exception 'ordered_after_received'; end if;
  update supplier_invoices set ordered_at = p_date where id = p_invoice;
end $function$;
revoke all on function public.set_supplier_ordered(uuid, date) from public, anon;
grant execute on function public.set_supplier_ordered(uuid, date) to authenticated;

-- average working days between ordering and receiving, per supplier (owner only)
create or replace function public.supplier_lead_times()
returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select case when my_role() = 'owner' then coalesce(jsonb_agg(jsonb_build_object('supplier', s.id, 'name', s.name, 'n', x.n, 'avg_days', x.avg_days, 'max_days', x.max_days) order by s.name), '[]') else '[]'::jsonb end
  from (select supplier_id, count(*) n, round(avg(date - ordered_at), 1) avg_days, max(date - ordered_at) max_days
        from supplier_invoices where not coalesce(void, false) and ordered_at is not null group by 1) x
  join suppliers s on s.id = x.supplier_id
$function$;
revoke all on function public.supplier_lead_times() from public, anon;
grant execute on function public.supplier_lead_times() to authenticated;

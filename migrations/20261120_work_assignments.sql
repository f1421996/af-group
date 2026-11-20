-- Work assignments: the owner sends the decision-center distribution to the workers' screens.
-- An assignment is NOT a claim: the worker still presses "ابدأ" himself, so start times
-- (line_timing) stay real. Nothing existing is changed: claim_lines / check_lines are untouched.
-- Access is through the functions below only (RLS on, no policies).

create table if not exists public.work_assignments (
  id            bigint generated always as identity primary key,
  line_id       uuid not null references public.invoice_lines(id) on delete cascade,
  worker_id     uuid not null references public.profiles(id) on delete cascade,
  worker_name   text not null,
  pos           int  not null default 0,
  est_mins      numeric,
  send_id       uuid not null,
  assigned_by   uuid,
  assigned_at   timestamptz not null default now(),
  released_at   timestamptz,
  released_by   uuid,
  release_reason text check (release_reason in ('declined','reassigned','owner'))
);
create unique index if not exists work_assignments_one_active on public.work_assignments(line_id) where released_at is null;
create index if not exists work_assignments_worker on public.work_assignments(worker_id) where released_at is null;
alter table public.work_assignments enable row level security;
revoke all on public.work_assignments from anon, authenticated;

-- Owner sends a distribution. p_items: [{line, worker, pos, mins}]
-- A line somebody else already started stays with him and is reported back as skipped.
-- p_replace: older assignments that are not in this send and were not started are released.
create or replace function public.assign_work(p_items jsonb, p_replace boolean default true)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare it record; l record; sid uuid := gen_random_uuid(); sk jsonb := '[]'; n int := 0; rel int := 0; ws jsonb; w record;
begin
  if my_role() is distinct from 'owner' then raise exception 'not_allowed'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'no_items'; end if;
  if jsonb_array_length(p_items) > 3000 then raise exception 'too_many_items'; end if;
  if exists (select 1 from jsonb_to_recordset(p_items) as x(line uuid, worker uuid) where x.line is null or x.worker is null) then raise exception 'bad_item'; end if;
  if exists (select 1 from jsonb_to_recordset(p_items) as x(line uuid) group by x.line having count(*) > 1) then raise exception 'duplicate_line'; end if;
  if exists (select 1 from jsonb_to_recordset(p_items) as x(worker uuid)
             left join profiles p on p.id = x.worker and p.active and p.role = 'stock' where p.id is null) then raise exception 'bad_worker'; end if;

  for it in select x.line, x.worker, coalesce(x.pos, 0) pos, x.mins, p.name wname
            from jsonb_to_recordset(p_items) as x(line uuid, worker uuid, pos int, mins numeric)
            join profiles p on p.id = x.worker order by x.line loop
    select il.id, il.name, il.done_at, il.done_name, il.claim_by, il.claim_name, il.claim_at into l
      from invoice_lines il join invoices i on i.id = il.invoice_id
      where il.id = it.line and il.active and i.deleted_at is null and i.fulfilled_at is null and i.cancelled_by is null
      for update of il;
    if not found then sk := sk || jsonb_build_object('line', it.line, 'why', 'gone'); continue; end if;
    if l.done_at is not null then sk := sk || jsonb_build_object('line', it.line, 'name', l.name, 'why', 'done', 'by', l.done_name); continue; end if;
    -- same rule as claim_lines: a claim older than 2 hours no longer holds the line
    if l.claim_by is not null and l.claim_by <> it.worker and l.claim_at > now() - interval '2 hours' then
      sk := sk || jsonb_build_object('line', it.line, 'name', l.name, 'why', 'started', 'by', l.claim_name); continue; end if;
    update work_assignments set released_at = now(), released_by = auth.uid(), release_reason = 'reassigned'
      where line_id = it.line and released_at is null and worker_id <> it.worker;
    update work_assignments set pos = it.pos, est_mins = it.mins, send_id = sid
      where line_id = it.line and released_at is null and worker_id = it.worker;
    if not found then
      insert into work_assignments(line_id, worker_id, worker_name, pos, est_mins, send_id, assigned_by)
        values (it.line, it.worker, it.wname, it.pos, it.mins, sid, auth.uid());
    end if;
    n := n + 1;
  end loop;

  if p_replace then
    with x as (
      update work_assignments a set released_at = now(), released_by = auth.uid(), release_reason = 'reassigned'
      from invoice_lines il
      where il.id = a.line_id and a.released_at is null and a.send_id <> sid
        and il.done_at is null and (il.claim_by is null or il.claim_by <> a.worker_id or il.claim_at <= now() - interval '2 hours')
      returning 1)
    select count(*) into rel from x;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', q.worker_id, 'name', q.worker_name, 'lines', q.n, 'pcs', q.pcs, 'new', q.fresh) order by q.worker_name), '[]') into ws
  from (select a.worker_id, a.worker_name, count(*) n, sum(il.qty) pcs, count(*) filter (where a.assigned_at = now()) fresh
        from work_assignments a join invoice_lines il on il.id = a.line_id
        where a.send_id = sid and a.released_at is null group by 1, 2) q;

  -- one notification per worker who got something new (reuses the existing per-user push type)
  for w in select * from jsonb_to_recordset(ws) as x(id uuid, name text, lines int, pcs numeric, "new" int) loop
    if w."new" > 0 then
      perform push_fire(jsonb_build_object('type', 'override_res', 'user', w.id, 'title', '📋 شغلك النهارده',
        'body', format('اتوزع عليك %s صنف · %s قطعة. افتح "شغلي" وابدأ بالترتيب.', w.lines, round(w.pcs))));
    end if;
  end loop;

  insert into audit_log(user_id, action, detail)
    values (auth.uid(), 'work_assigned', jsonb_build_object('send', sid, 'assigned', n, 'released', rel, 'skipped', jsonb_array_length(sk), 'workers', ws));
  return jsonb_build_object('send', sid, 'assigned', n, 'released', rel, 'skipped', sk, 'workers', ws);
end $function$;

-- What the worker screen needs: every active assignment on an open line (plus the ones finished today, for progress).
create or replace function public.work_assignments_active()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare r text := my_role(); res jsonb;
begin
  if r is null or r not in ('owner', 'stock', 'maker') then raise exception 'not_allowed'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('line', a.line_id, 'worker', a.worker_id, 'name', a.worker_name, 'pos', a.pos, 'mins', a.est_mins,
           'qty', il.qty, 'at', a.assigned_at, 'done', il.done_at is not null, 'done_by', il.done_name) order by a.worker_name, a.pos, a.id), '[]') into res
  from work_assignments a join invoice_lines il on il.id = a.line_id join invoices i on i.id = il.invoice_id
  where a.released_at is null and il.active and i.deleted_at is null and i.cancelled_by is null
    and ((il.done_at is null and i.fulfilled_at is null)
      or il.done_at >= (date_trunc('day', now() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo'));
  return res;
end $function$;

-- Worker: "مش هقدر أعمله" on his own lines (also drops his own claim). Owner: cancel any assignment.
create or replace function public.unassign_work(p_lines uuid[], p_note text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare r text := my_role(); nm text; n int := 0; names text;
begin
  if r is null or r not in ('owner', 'stock', 'maker') then raise exception 'not_allowed'; end if;
  if p_lines is null or cardinality(p_lines) = 0 then return jsonb_build_object('released', 0); end if;
  select name into nm from profiles where id = auth.uid();
  with x as (
    update work_assignments a set released_at = now(), released_by = auth.uid(),
           release_reason = case when r = 'owner' then 'owner' else 'declined' end
    where a.line_id = any(p_lines) and a.released_at is null and (r = 'owner' or a.worker_id = auth.uid())
      and exists (select 1 from invoice_lines il where il.id = a.line_id and il.done_at is null)
    returning a.line_id)
  select count(*), (select string_agg(il.name || ' × ' || round(il.qty), '، ') from invoice_lines il where il.id in (select line_id from x))
    into n, names from x;
  if n > 0 and r <> 'owner' then
    update invoice_lines set claim_by = null, claim_name = null, claim_at = null
      where id = any(p_lines) and claim_by = auth.uid() and done_at is null;
    perform push_fire(jsonb_build_object('type', 'override', 'title', '↩️ ' || coalesce(nm, 'عامل') || ' رجّع شغل',
      'body', left(coalesce(names, '') || coalesce(' · ' || nullif(btrim(p_note), ''), ''), 380)));
  end if;
  if n > 0 then
    insert into audit_log(user_id, action, detail)
      values (auth.uid(), case when r = 'owner' then 'work_unassigned' else 'work_declined' end,
              jsonb_build_object('n', n, 'items', names, 'note', nullif(btrim(coalesce(p_note, '')), '')));
  end if;
  return jsonb_build_object('released', n);
end $function$;

-- Owner follow-up: per worker — assigned / started / done, plus what was handed back today.
create or replace function public.work_progress()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare res jsonb; d0 timestamptz := (date_trunc('day', now() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo');
begin
  if my_role() is distinct from 'owner' then raise exception 'not_allowed'; end if;
  select jsonb_build_object(
    'workers', (select coalesce(jsonb_agg(to_jsonb(q) order by q.name), '[]') from (
        select a.worker_id id, a.worker_name name, count(*) lines, sum(il.qty) pcs,
               count(*) filter (where il.done_at is null and il.claim_by = a.worker_id and il.claim_at > now() - interval '2 hours') started,
               count(*) filter (where il.done_at is not null) done,
               coalesce(sum(il.qty) filter (where il.done_at is not null), 0) done_pcs,
               count(*) filter (where il.done_at is not null and il.done_by is distinct from a.worker_id) done_by_other,
               count(*) filter (where il.done_at is null and il.claim_by is not null and il.claim_by <> a.worker_id and il.claim_at > now() - interval '2 hours') taken_by_other,
               round(coalesce(sum(a.est_mins) filter (where il.done_at is null), 0)) mins_left,
               max(a.assigned_at) last_at
        from work_assignments a join invoice_lines il on il.id = a.line_id join invoices i on i.id = il.invoice_id
        where a.released_at is null and il.active and i.deleted_at is null and i.cancelled_by is null
          and ((il.done_at is null and i.fulfilled_at is null) or il.done_at >= d0)
        group by 1, 2) q),
    'declined', (select coalesce(jsonb_agg(jsonb_build_object('worker', a.worker_name, 'name', il.name, 'qty', il.qty, 'no', i.no, 'line', il.id, 'at', a.released_at) order by a.released_at desc), '[]')
        from work_assignments a join invoice_lines il on il.id = a.line_id join invoices i on i.id = il.invoice_id
        where a.release_reason = 'declined' and a.released_at >= d0 and il.active and il.done_at is null
          and not exists (select 1 from work_assignments b where b.line_id = a.line_id and b.released_at is null))
  ) into res;
  return res;
end $function$;

revoke all on function public.assign_work(jsonb, boolean) from public, anon;
revoke all on function public.work_assignments_active() from public, anon;
revoke all on function public.unassign_work(uuid[], text) from public, anon;
revoke all on function public.work_progress() from public, anon;
grant execute on function public.assign_work(jsonb, boolean) to authenticated;
grant execute on function public.work_assignments_active() to authenticated;
grant execute on function public.unassign_work(uuid[], text) to authenticated;
grant execute on function public.work_progress() to authenticated;

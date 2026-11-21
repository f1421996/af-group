-- opt_extras(): adds 'rates' = each stock worker's real daily output (pieces per working day, last 14 days),
-- so the decision center can plan what a worker can actually finish. Read-only, owner-only, nothing else changes.
create or replace function public.opt_extras()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare r jsonb;
begin
  if my_role() is distinct from 'owner' then raise exception 'not_allowed'; end if;
  with t as (
    select lt.qty, lt.started_at, lt.worker_id,
      extract(epoch from (lt.done_at - greatest(lt.started_at, coalesce(lag(lt.done_at) over (partition by lt.worker_id, (lt.done_at at time zone 'Africa/Cairo')::date order by lt.done_at), lt.started_at))))/60 mins
    from line_timing lt
    where lt.undone_at is null and lt.worker_id not in (select id from profiles where role='owner')),
  u as (select * from t where started_at is not null and mins between 0.25 and 120),
  d as (select lt.worker_id, (lt.done_at at time zone 'Africa/Cairo')::date day, sum(lt.qty) pcs, count(*) ln
        from line_timing lt
        where lt.undone_at is null and lt.done_at >= now() - interval '14 days'
          and (lt.done_at at time zone 'Africa/Cairo')::date < (now() at time zone 'Africa/Cairo')::date  -- full days only: today is not over yet
        group by 1, 2)
  select jsonb_build_object(
    'makers', (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'maker',p.maker,
                 'worked',exists(select 1 from u where u.worker_id=p.id)) order by p.name),'[]')
               from profiles p where p.active and p.role='stock'),
    'claims', (select coalesce(jsonb_agg(jsonb_build_object('line',l.id,'by',l.claim_by,'name',l.claim_name)),'[]')
               from invoice_lines l join invoices i on i.id=l.invoice_id
               where l.active and l.done_at is null and l.claim_by is not null and i.deleted_at is null and i.fulfilled_at is null),
    'timing', (select jsonb_build_object('n',count(*),'setup',round(regr_intercept(mins,qty)::numeric,2),'per_pc',round(regr_slope(mins,qty)::numeric,3),
               'r2',round(regr_r2(mins,qty)::numeric,2),'from',(select min(done_at)::date from line_timing)) from u),
    'rates', (select coalesce(jsonb_agg(jsonb_build_object('id',d.worker_id,'days',d.n,'pcs_day',d.pd,'lines_day',d.ld)),'[]')
              from (select worker_id, count(*) n, round(avg(pcs),1) pd, round(avg(ln),1) ld from d
                    where worker_id in (select id from profiles where active and role='stock') group by 1) d)
  ) into r;
  return r;
end $function$;

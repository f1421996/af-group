-- PROPOSED — NOT APPLIED. Needs owner approval before running on production.
-- Decision Center: independent verification inside Postgres (exact numeric) + human approval.
-- Touches only public.decision_runs (currently empty) and adds two owner-only functions. No operational table is changed.
-- Rollback: see the block at the end.

alter table public.decision_runs
  add column if not exists status text not null default 'draft',
  add column if not exists db_check jsonb,
  add column if not exists checked_at timestamptz,
  add column if not exists decided_by uuid,
  add column if not exists decided_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'decision_runs_status_chk') then
    alter table public.decision_runs add constraint decision_runs_status_chk
      check (status in ('draft','verified','failed','approved','rejected'));
  end if;
end $$;

-- Recomputes every constraint and every money figure of a saved run from its own stored snapshot,
-- with numeric arithmetic, independently of the JavaScript solver and verifier.
create or replace function public.decision_verify(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r decision_runs; s jsonb; d jsonb; prm jsonb;
  checks jsonb := '[]'; ok boolean := true; c_ok boolean; det text;
  n_ids int; n_found int; spend numeric; revenue numeric; budget numeric; pcs numeric;
begin
  if my_role() is distinct from 'owner' then raise exception 'not_allowed'; end if;
  select * into r from decision_runs where id = p_id for update;
  if not found then raise exception 'run_not_found'; end if;
  if r.status in ('approved','rejected') then raise exception 'already_decided'; end if;
  s := r.snapshot; d := r.result->'decision'; prm := coalesce(r.params, '{}');
  if s is null or d is null then raise exception 'run_incomplete'; end if;

  drop table if exists _f, _b;
  create temp table _f on commit drop as
    select l.* from jsonb_to_recordset(s->'lines') l(id text, inv_id text, qty numeric, price numeric, page_pc numeric,
                                                     grams numeric, oil_id text, empty_id text, track boolean)
    where l.id in (select jsonb_array_elements_text(d->'filledIds'));
  create temp table _b on commit drop as
    select b.* from jsonb_to_recordset(coalesce(d->'buys','[]')) b(kind text, id text, sup text, qty numeric, lot numeric, ppg numeric);

  -- 1) every filled line exists in the snapshot, once
  n_ids := jsonb_array_length(d->'filledIds'); select count(*) into n_found from _f;
  c_ok := n_ids = n_found and n_ids = (select count(distinct x) from jsonb_array_elements_text(d->'filledIds') x);
  checks := checks || jsonb_build_object('name','السطور المختارة موجودة في لقطة البيانات','ok',c_ok,'detail',n_found||' من '||n_ids);
  ok := ok and c_ok;

  -- 2) oil: used <= on hand (negative counted as zero) + bought
  select string_agg(coalesce(o.name, u.oil_id)||': ناقص '||round(u.g - greatest(coalesce(o.stock,0),0) - coalesce(b.q,0))||' جم', '، ')
    into det
  from (select oil_id, sum(qty*grams) g from _f where oil_id is not null and coalesce(grams,0) > 0 group by 1) u
  left join jsonb_to_recordset(s->'oils') o(id text, name text, stock numeric) on o.id = u.oil_id
  left join (select id, sum(qty) q from _b where kind='oil' group by 1) b on b.id = u.oil_id
  where u.g > greatest(coalesce(o.stock,0),0) + coalesce(b.q,0) + 0.000001;
  c_ok := det is null;
  checks := checks || jsonb_build_object('name','الزيت: المستخدم ≤ الموجود + المشترى','ok',c_ok,'detail',coalesce(det,'سليم'));
  ok := ok and c_ok;

  -- 3) empties: used <= shelf + bought
  select string_agg(coalesce(e.name, u.empty_id)||': ناقص '||(u.q - greatest(coalesce(e.shelf,0),0) - coalesce(b.q,0)), '، ')
    into det
  from (select empty_id, sum(qty) q from _f where track and empty_id is not null group by 1) u
  left join jsonb_to_recordset(s->'empties') e(id text, name text, shelf numeric) on e.id = u.empty_id
  left join (select id, sum(qty) q from _b where kind='empty' group by 1) b on b.id = u.empty_id
  where u.q > greatest(coalesce(e.shelf,0),0) + coalesce(b.q,0) + 0.000001;
  c_ok := det is null;
  checks := checks || jsonb_build_object('name','الفوارغ: المستخدم ≤ الموجود + المشترى','ok',c_ok,'detail',coalesce(det,'سليم'));
  ok := ok and c_ok;

  -- 4) quantities are positive whole multiples of the stated purchase unit
  select count(*) into n_found from _b where coalesce(qty,0) <= 0 or coalesce(lot,0) <= 0 or qty / lot <> round(qty / lot);
  c_ok := n_found = 0;
  checks := checks || jsonb_build_object('name','كميات الشراء مضاعفات وحدة الشراء','ok',c_ok,'detail',case when c_ok then 'سليم' else n_found||' كمية غير مظبوطة' end);
  ok := ok and c_ok;

  -- 5) supplier prices equal the recorded price (± the scenario percentage)
  select count(*) into n_found
  from _b b
  left join jsonb_to_recordset(s->'prices') p(oil_id text, sup_id text, ppg numeric) on p.oil_id = b.id and p.sup_id = b.sup
  where b.kind = 'oil' and b.sup is not null
    and (p.ppg is null or abs(p.ppg * (1 + coalesce((prm->'supUp'->>b.sup)::numeric,0)/100) - b.ppg) > 0.000001);
  c_ok := n_found = 0;
  checks := checks || jsonb_build_object('name','أسعار الشراء = الأسعار المسجلة','ok',c_ok,'detail',case when c_ok then 'سليم' else n_found||' سعر مختلف' end);
  ok := ok and c_ok;

  -- 6) no purchase from a disabled supplier
  select count(*) into n_found from _b b where b.kind='oil' and b.sup is not null and (prm->'supOn'->>b.sup) = 'false';
  c_ok := n_found = 0;
  checks := checks || jsonb_build_object('name','مفيش شراء من مورد واقف','ok',c_ok,'detail',case when c_ok then 'سليم' else n_found||' شراء' end);
  ok := ok and c_ok;

  -- 7) money, recomputed exactly
  select coalesce(sum(qty*ppg),0) into spend from _b;
  select coalesce(sum(qty*(coalesce(price,0) - coalesce(page_pc,0))),0), coalesce(sum(qty),0) into revenue, pcs from _f;
  budget := nullif(prm->>'budget','')::numeric;
  if budget is not null and budget < 1e11 then
    c_ok := spend <= budget + 0.005;
    checks := checks || jsonb_build_object('name','إجمالي الشراء ≤ الميزانية','ok',c_ok,'detail',round(spend,2)||' ≤ '||round(budget,2));
    ok := ok and c_ok;
  end if;
  c_ok := abs(spend - coalesce((r.result->>'buyCost')::numeric,0)) <= 0.01
      and abs(revenue - coalesce((r.result->>'revenue')::numeric,0)) <= 0.01
      and pcs = coalesce((r.result->>'pcs')::numeric,0);
  checks := checks || jsonb_build_object('name','الأرقام المالية المحفوظة = المعاد حسابها في القاعدة','ok',c_ok,
    'detail','شراء '||round(spend,2)||' · إيراد صافي '||round(revenue,2)||' · قطع '||pcs);
  ok := ok and c_ok;

  update decision_runs set status = case when ok then 'verified' else 'failed' end, checked_at = now(),
    db_check = jsonb_build_object('ok',ok,'checks',checks,'spend',round(spend,2),'revenue',round(revenue,2),'pcs',pcs)
  where id = p_id;
  insert into audit_log(user_id, action, ref, detail)
    values (auth.uid(), 'decision_verify', p_id, jsonb_build_object('ok',ok,'spend',round(spend,2),'revenue',round(revenue,2)));
  return jsonb_build_object('ok',ok,'checks',checks,'spend',round(spend,2),'revenue',round(revenue,2),'pcs',pcs);
end $$;

-- Human approval. A run can only be approved after it passed decision_verify. Nothing is executed automatically.
create or replace function public.decision_decide(p_id uuid, p_ok boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare r decision_runs;
begin
  if my_role() is distinct from 'owner' then raise exception 'not_allowed'; end if;
  select * into r from decision_runs where id = p_id for update;
  if not found then raise exception 'run_not_found'; end if;
  if r.status in ('approved','rejected') then raise exception 'already_decided'; end if;
  if p_ok and r.status <> 'verified' then raise exception 'not_verified'; end if;
  update decision_runs set status = case when p_ok then 'approved' else 'rejected' end, decided_by = auth.uid(), decided_at = now() where id = p_id;
  insert into audit_log(user_id, action, ref, detail)
    values (auth.uid(), case when p_ok then 'decision_approve' else 'decision_reject' end, p_id, jsonb_build_object('title', r.title));
  return jsonb_build_object('status', case when p_ok then 'approved' else 'rejected' end);
end $$;

revoke all on function public.decision_verify(uuid) from public, anon;
revoke all on function public.decision_decide(uuid, boolean) from public, anon;
grant execute on function public.decision_verify(uuid) to authenticated;
grant execute on function public.decision_decide(uuid, boolean) to authenticated;

-- ROLLBACK:
--   drop function if exists public.decision_verify(uuid);
--   drop function if exists public.decision_decide(uuid, boolean);
--   alter table public.decision_runs drop constraint if exists decision_runs_status_chk,
--     drop column if exists status, drop column if exists db_check, drop column if exists checked_at,
--     drop column if exists decided_by, drop column if exists decided_at;

-- Delivery deadline per invoice: manufacturing must be finished 4 working days after the invoice date
-- (Friday is the day off), then the order ships. The owner/billing can set a different date per invoice.
-- No existing row is rewritten: old invoices have due_date NULL and readers fall back to date + 4 working days.

create or replace function public.add_work_days(d date, n int)
returns date language plpgsql immutable set search_path to 'public' as $function$
declare r date := d; k int := 0;
begin
  if d is null then return null; end if;
  while k < greatest(n, 0) loop
    r := r + 1;
    if extract(dow from r) <> 5 then k := k + 1; end if;  -- 5 = Friday
  end loop;
  return r;
end $function$;

alter table public.invoices add column if not exists due_date date;
alter table public.invoices add column if not exists due_manual boolean not null default false;

-- New invoices get their deadline automatically; if the invoice date is edited later the automatic deadline follows it.
create or replace function public.trg_invoice_due()
returns trigger language plpgsql set search_path to 'public' as $function$
begin
  if tg_op = 'INSERT' then
    if new.due_date is null then new.due_date := add_work_days(new.date, 4); new.due_manual := false; end if;
  elsif new.date is distinct from old.date and not new.due_manual and new.due_date is not distinct from old.due_date then
    new.due_date := add_work_days(new.date, 4);
  end if;
  return new;
end $function$;
drop trigger if exists invoice_due on public.invoices;
create trigger invoice_due before insert or update of date on public.invoices for each row execute function public.trg_invoice_due();

-- Owner or billing sets (or resets, with NULL) the deadline of one invoice.
create or replace function public.set_due_date(p_invoice uuid, p_date date)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare r text := my_role(); i record; nd date;
begin
  if r is null or r not in ('owner', 'billing') then raise exception 'not_allowed'; end if;
  select id, no, date, due_date into i from invoices where id = p_invoice and deleted_at is null for update;
  if not found then raise exception 'not_found'; end if;
  if p_date is not null and p_date < i.date then raise exception 'due_before_invoice_date'; end if;
  nd := coalesce(p_date, add_work_days(i.date, 4));
  update invoices set due_date = nd, due_manual = (p_date is not null) where id = p_invoice;
  insert into audit_log(user_id, action, ref, detail)
    values (auth.uid(), 'due_set', p_invoice, jsonb_build_object('no', i.no, 'old', coalesce(i.due_date, add_work_days(i.date, 4)), 'due', nd, 'manual', p_date is not null));
  return jsonb_build_object('due', nd, 'manual', p_date is not null);
end $function$;
revoke all on function public.set_due_date(uuid, date) from public, anon;
grant execute on function public.set_due_date(uuid, date) to authenticated;

-- opt_snapshot: same as before + each open line carries its invoice deadline (due, due_manual).
create or replace function public.opt_snapshot(p_days integer default 45)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare r jsonb;
begin
  if my_role() is distinct from 'owner' then raise exception 'not_allowed'; end if;
  with ol as (
    select l.id, i.id inv_id, i.no, i.page_id, i.date, i.work_rank rank, i.cust->>'name' cust,
           coalesce(i.due_date, add_work_days(i.date, 4)) due, i.due_manual,
           l.name, l.qty, l.price, coalesce(i.page_profit_pc,0) page_pc,
           coalesce(l.grams, rc.grams) grams, rc.oil_id, coalesce(p.stock_of,p.id) empty_id, coalesce(p.track,false) track
    from invoices i join invoice_lines l on l.invoice_id=i.id
    left join products p on p.id=l.product_id
    left join product_recipe rc on rc.product_id=l.product_id
    where i.deleted_at is null and i.fulfilled_at is null and i.cancelled_by is null
      and l.active and l.done_at is null and not coalesce(l.mat_done,false)
  ),
  oils as (
    select m.id, m.name, m.cnt_no, m.stock, mc.cost
    from materials m left join material_costs mc on mc.material_id=m.id
    where m.active and m.kind='oil'
  ),
  prices as (
    select distinct on (l.material_id, i.supplier_id) l.material_id oil_id, i.supplier_id sup_id, i.date, i.number inv_no,
      l.qty src_qty, l.unit src_unit, l.net_total src_net,
      round(l.net_total/ nullif(l.qty*case when l.unit='kg' then 1000 else 1 end,0),4) ppg
    from supplier_invoice_lines l join supplier_invoices i on i.id=l.invoice_id
    where not coalesce(i.void,false) and l.material_id is not null and l.unit in ('kg','g') and l.qty>0
    order by l.material_id, i.supplier_id, i.date desc, i.created_at desc
  ),
  emp as (
    select p.id, p.name, p.cnt_no, s.qty + empty_reserved(p.id) shelf, pc.cost
    from products p join product_stock s on s.product_id=p.id left join product_costs pc on pc.product_id=p.id
    where p.track and p.stock_of is null and p.id in (select empty_id from ol)
  ),
  usage as (
    select rc.oil_id, (l.done_at at time zone 'Africa/Cairo')::date d, sum(l.qty*coalesce(l.grams_actual,l.grams,rc.grams)) g
    from invoice_lines l join product_recipe rc on rc.product_id=l.product_id
    where l.mat_done and l.active and l.done_at >= now()-make_interval(days=>p_days) and rc.oil_id is not null
    group by 1,2
  )
  select jsonb_build_object(
    'at', now(), 'days', p_days, 'today', (now() at time zone 'Africa/Cairo')::date,
    'lines', (select coalesce(jsonb_agg(to_jsonb(ol) order by ol.rank nulls last, ol.date, ol.no),'[]') from ol),
    'oils', (select coalesce(jsonb_agg(to_jsonb(oils) order by oils.cnt_no),'[]') from oils),
    'prices', (select coalesce(jsonb_agg(to_jsonb(prices) order by prices.oil_id, prices.sup_id),'[]') from prices),
    'empties', (select coalesce(jsonb_agg(to_jsonb(emp) order by emp.cnt_no),'[]') from emp),
    'suppliers', (select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,
        'balance',(select coalesce(sum(case when kind='buy' then amount else -amount end),0) from supplier_moves m where m.supplier_id=s.id and not coalesce(m.void,false))) order by s.name),'[]') from suppliers s where s.active),
    'usage', (select coalesce(jsonb_agg(jsonb_build_object('oil_id',oil_id,'d',d,'g',round(g,2)) order by oil_id, d),'[]') from usage),
    'workers', (select coalesce(jsonb_agg(x order by x.name),'[]') from (select worker_name name, sum(qty) pcs,
        round(sum(extract(epoch from done_at-started_at))/3600.0,2) hrs, count(distinct (done_at at time zone 'Africa/Cairo')::date) days
        from line_timing where done_at is not null and undone_at is null and started_at is not null and done_at>=now()-interval '30 days' group by 1) x)
  ) into r;
  return r;
end $function$;

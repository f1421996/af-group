-- Planning: reorder point (ROP) for oils and empties + open purchase orders.
-- ADDITIVE ONLY: new tables and functions. No existing table, column, trigger or stock logic is changed.
-- Empties stay what they are today (products + product_stock); they are NOT added as materials.
-- Access is through the functions below only (RLS on, no policies).

create table if not exists public.plan_settings (k text primary key, v numeric not null);
insert into public.plan_settings(k, v) values
  ('adu_window_days', 30), ('safety_days', 2), ('review_days', 5), ('default_lead_days', 2), ('oil_lot_g', 50), ('emp_lot', 1)
on conflict (k) do nothing;

create table if not exists public.plan_supplier (
  supplier_id uuid primary key references public.suppliers(id) on delete cascade,
  lead_days numeric not null check (lead_days >= 0 and lead_days <= 90)
);
insert into public.plan_supplier(supplier_id, lead_days)
  select id, case when name in ('الحسيني', 'الفارس جروب (فوارغ)') then 4 else 2 end
  from public.suppliers where name in ('حامد للعطور', 'المواردي', 'الحسيني', 'الفارس جروب (فوارغ)')
on conflict (supplier_id) do nothing;

-- Optional per-item overrides. kind: 'oil' -> materials.id, 'emp' -> products.id (the stock owner, not an alias)
create table if not exists public.plan_item (
  kind text not null check (kind in ('oil', 'emp')),
  item_id uuid not null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  safety_days numeric check (safety_days >= 0 and safety_days <= 60),
  lot_size numeric check (lot_size > 0),
  ignore boolean not null default false,
  primary key (kind, item_id)
);

-- An open order does NOT change stock. Stock still rises only when the supplier invoice is entered, as today.
create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references public.suppliers(id),
  status text not null default 'open' check (status in ('open', 'received', 'cancelled')),
  ordered_at date not null default (now() at time zone 'Africa/Cairo')::date,
  expected_at date,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid,
  invoice_id uuid references public.supplier_invoices(id) on delete set null
);
create table if not exists public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.purchase_orders(id) on delete cascade,
  kind text not null check (kind in ('oil', 'emp')),
  item_id uuid not null,
  name text not null,
  qty numeric not null check (qty > 0)
);
create index if not exists purchase_order_lines_po on public.purchase_order_lines(po_id);
create index if not exists purchase_orders_open on public.purchase_orders(status) where status = 'open';

alter table public.plan_settings enable row level security;
alter table public.plan_supplier enable row level security;
alter table public.plan_item enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;
revoke all on public.plan_settings, public.plan_supplier, public.plan_item, public.purchase_orders, public.purchase_order_lines from anon, authenticated;

-- Everything the planning screen shows. Every number is plain arithmetic and is returned with its inputs.
--   adu       = net consumption in the window / window days
--   avail     = max(on hand, 0) - reserved for open orders + on order
--   ss        = adu * safety days          rop = adu * lead + ss
--   target    = adu * (lead + review) + ss qty = ceil(max(0, target - avail) / lot) * lot
--   red: avail <= rop     yellow: avail <= rop + adu*3
create or replace function public.plan_status()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare r text := my_role(); own boolean; res jsonb;
  w numeric; sd numeric; rv numeric; dl numeric; lo numeric; le numeric;
begin
  if r is null or r not in ('owner', 'stock') then raise exception 'not_allowed'; end if;
  own := r = 'owner';
  select coalesce(max(v) filter (where k = 'adu_window_days'), 30), coalesce(max(v) filter (where k = 'safety_days'), 2),
         coalesce(max(v) filter (where k = 'review_days'), 5), coalesce(max(v) filter (where k = 'default_lead_days'), 2),
         coalesce(max(v) filter (where k = 'oil_lot_g'), 50), coalesce(max(v) filter (where k = 'emp_lot'), 1)
    into w, sd, rv, dl, lo, le from plan_settings;
  w := greatest(w, 1);

  with oo as (
    select pl.kind, pl.item_id, sum(pl.qty) q from purchase_order_lines pl join purchase_orders po on po.id = pl.po_id
    where po.status = 'open' group by 1, 2),
  ol as (  -- open lines, same definition as shortage_report
    select l.qty, coalesce(l.grams, rc.grams) g, rc.oil_id
    from invoice_lines l join invoices i on i.id = l.invoice_id join products p on p.id = l.product_id
    left join product_recipe rc on rc.product_id = l.product_id
    where l.active and l.done_at is null and i.deleted_at is null and i.fulfilled_at is null and i.cancelled_by is null
      and p.track and not coalesce(l.from_ready, false)),
  oil as (
    select 'oil'::text kind, m.id, m.name, m.cnt_no no, m.stock onhand,
      greatest(0, -coalesce((select sum(ml.delta) from material_log ml where ml.material_id = m.id
          and ml.reason in ('invoice', 'invoice_undo') and ml.created_at > now() - make_interval(days => w::int)), 0)) / w adu,
      coalesce((select sum(ol.qty * ol.g) from ol where ol.oil_id = m.id and ol.g is not null), 0) alloc,
      (select si.supplier_id from supplier_invoice_lines sl join supplier_invoices si on si.id = sl.invoice_id
         where not coalesce(si.void, false) and sl.material_id = m.id order by si.date desc, si.created_at desc limit 1) last_sup,
      (select round(sl.price / case when sl.unit = 'g' then 0.001 else 1 end) from supplier_invoice_lines sl join supplier_invoices si on si.id = sl.invoice_id
         where not coalesce(si.void, false) and sl.material_id = m.id order by si.date desc, si.created_at desc limit 1) / 1000.0 last_price,
      (select max(ml.created_at) from material_log ml where ml.material_id = m.id and ml.reason = 'count') last_count
    from materials m where m.active and m.kind = 'oil'),
  emp as (
    select 'emp'::text kind, p.id, p.name, p.cnt_no no,
      coalesce(s.qty, 0) + empty_reserved(p.id) onhand,
      coalesce((select sum(l.qty) from invoice_lines l join invoices i on i.id = l.invoice_id
          where (l.product_id = p.id or l.product_id in (select id from products where stock_of = p.id))
            and l.active and i.deleted_at is null and i.cancelled_by is null and i.date > current_date - w::int), 0) / w adu,
      empty_reserved(p.id) alloc,
      (select si.supplier_id from supplier_invoice_lines sl join supplier_invoices si on si.id = sl.invoice_id
         where not coalesce(si.void, false) and sl.material_id is null and (sl.name = p.name or sl.name = 'فارغ ' || p.name)
         order by si.date desc, si.created_at desc limit 1) last_sup,
      (select cost from purchases where product_id = p.id and cost is not null order by created_at desc limit 1) last_price,
      null::timestamptz last_count
    from products p left join product_stock s on s.product_id = p.id
    where p.track and not coalesce(p.hidden, false) and p.stock_of is null),
  a as (
    select x.*, coalesce(oo.q, 0) on_order, coalesce(pi.supplier_id, x.last_sup) sup_id,
      coalesce(pi.safety_days, sd) sdays, coalesce(pi.lot_size, case when x.kind = 'oil' then lo else le end) lot, coalesce(pi.ignore, false) ign
    from (select * from oil union all select * from emp) x
    left join oo on oo.kind = x.kind and oo.item_id = x.id
    left join plan_item pi on pi.kind = x.kind and pi.item_id = x.id),
  b as (
    select a.*, s.name sup_name, coalesce(ps.lead_days, dl) lead,
      greatest(a.onhand, 0) - a.alloc + a.on_order avail
    from a left join suppliers s on s.id = a.sup_id left join plan_supplier ps on ps.supplier_id = a.sup_id),
  c as (
    select b.*, b.adu * b.sdays ss, b.adu * b.lead + b.adu * b.sdays rop, b.adu * (b.lead + rv) + b.adu * b.sdays target
    from b where not (b.adu = 0 and b.alloc = 0 and b.on_order = 0 and b.onhand >= 0)),
  d as (
    select c.*, case when c.avail <= c.rop and (c.adu > 0 or c.avail < 0) then 'red'
                     when c.adu > 0 and c.avail <= c.rop + c.adu * 3 then 'yellow' else 'green' end status,
      ceil(greatest(0, c.target - c.avail) / c.lot) * c.lot qty
    from c)
  select jsonb_build_object(
    'at', now(), 'owner', own,
    'settings', jsonb_build_object('adu_window_days', w, 'safety_days', sd, 'review_days', rv, 'default_lead_days', dl, 'oil_lot_g', lo, 'emp_lot', le),
    'suppliers', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'lead', coalesce(ps.lead_days, dl), 'set', ps.supplier_id is not null,
          'actual', (select round(avg(si.date - si.ordered_at), 1) from supplier_invoices si where si.supplier_id = s.id and not coalesce(si.void, false) and si.ordered_at is not null),
          'actual_n', (select count(*) from supplier_invoices si where si.supplier_id = s.id and not coalesce(si.void, false) and si.ordered_at is not null)) order by s.name), '[]')
        from suppliers s left join plan_supplier ps on ps.supplier_id = s.id where s.active),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('kind', d.kind, 'id', d.id, 'name', d.name, 'no', d.no,
          'onhand', round(d.onhand, 1), 'neg', d.onhand < 0, 'adu', round(d.adu, 2), 'alloc', round(d.alloc, 1), 'on_order', d.on_order,
          'avail', round(d.avail, 1), 'sup', d.sup_id, 'sup_name', d.sup_name, 'lead', d.lead, 'sdays', d.sdays, 'lot', d.lot, 'ign', d.ign,
          'ss', round(d.ss, 1), 'rop', round(d.rop, 1), 'target', round(d.target, 1), 'status', d.status, 'qty', d.qty,
          'doc', case when d.adu > 0 then round(d.avail / d.adu, 1) end,
          'price', case when own then d.last_price end, 'last_count', d.last_count)
          order by case d.status when 'red' then 0 when 'yellow' then 1 else 2 end, case when d.adu > 0 then d.avail / d.adu else -1e9 end), '[]') from d),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object('id', po.id, 'sup', po.supplier_id, 'sup_name', s.name, 'ordered_at', po.ordered_at, 'expected_at', po.expected_at,
          'note', po.note, 'late', po.expected_at < (now() at time zone 'Africa/Cairo')::date,
          'lines', (select coalesce(jsonb_agg(jsonb_build_object('kind', pl.kind, 'id', pl.item_id, 'name', pl.name, 'qty', pl.qty) order by pl.name), '[]') from purchase_order_lines pl where pl.po_id = po.id))
          order by po.ordered_at, po.created_at), '[]')
        from purchase_orders po left join suppliers s on s.id = po.supplier_id where po.status = 'open')
  ) into res;
  return res;
end $function$;

-- Owner records "I ordered this". p_lines: [{kind, id, qty}]
create or replace function public.plan_po_create(p_supplier uuid, p_lines jsonb, p_note text default null)
returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare pid uuid; n int; ld numeric; d date := (now() at time zone 'Africa/Cairo')::date;
begin
  if my_role() is distinct from 'owner' then raise exception 'not_allowed'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'no_items'; end if;
  if jsonb_array_length(p_lines) > 500 then raise exception 'too_many_items'; end if;
  if p_supplier is not null and not exists (select 1 from suppliers where id = p_supplier) then raise exception 'bad_supplier'; end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as x(kind text, id uuid, qty numeric)
             where x.kind is null or x.kind not in ('oil', 'emp') or x.id is null or x.qty is null or x.qty <= 0) then raise exception 'bad_item'; end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as x(kind text, id uuid) group by x.kind, x.id having count(*) > 1) then raise exception 'duplicate_item'; end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as x(kind text, id uuid)
             where (x.kind = 'oil' and not exists (select 1 from materials m where m.id = x.id))
                or (x.kind = 'emp' and not exists (select 1 from products p where p.id = x.id))) then raise exception 'unknown_item'; end if;
  select coalesce((select lead_days from plan_supplier where supplier_id = p_supplier), (select v from plan_settings where k = 'default_lead_days'), 2) into ld;
  insert into purchase_orders(supplier_id, ordered_at, expected_at, note, created_by)
    values (p_supplier, d, d + ceil(ld)::int, nullif(btrim(coalesce(p_note, '')), ''), auth.uid()) returning id into pid;
  insert into purchase_order_lines(po_id, kind, item_id, name, qty)
    select pid, x.kind, x.id, case when x.kind = 'oil' then (select name from materials where id = x.id) else (select name from products where id = x.id) end, x.qty
    from jsonb_to_recordset(p_lines) as x(kind text, id uuid, qty numeric);
  get diagnostics n = row_count;
  insert into audit_log(user_id, action, detail) values (auth.uid(), 'po_created', jsonb_build_object('po', pid, 'supplier', p_supplier, 'lines', n));
  return pid;
end $function$;

-- Owner closes an open order by hand. If he names the supplier invoice that delivered it and that invoice has no
-- "ordered on" date yet, the order date is copied there so the real lead time is measured. Nothing else is touched.
create or replace function public.plan_po_close(p_id uuid, p_status text, p_invoice uuid default null)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare po record;
begin
  if my_role() is distinct from 'owner' then raise exception 'not_allowed'; end if;
  if p_status is null or p_status not in ('received', 'cancelled') then raise exception 'bad_status'; end if;
  select * into po from purchase_orders where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if po.status <> 'open' then raise exception 'already_closed'; end if;
  if p_invoice is not null and p_status = 'received' then
    update supplier_invoices set ordered_at = po.ordered_at
      where id = p_invoice and ordered_at is null and date >= po.ordered_at and supplier_id is not distinct from po.supplier_id;
  end if;
  update purchase_orders set status = p_status, closed_at = now(), closed_by = auth.uid(),
         invoice_id = case when p_status = 'received' then p_invoice end where id = p_id;
  insert into audit_log(user_id, action, detail) values (auth.uid(), 'po_' || p_status, jsonb_build_object('po', p_id, 'invoice', p_invoice));
end $function$;

-- Owner changes planning numbers. p: {settings:{k:v}, supplier:{id, lead_days}, item:{kind, id, supplier, safety_days, lot_size, ignore}}
create or replace function public.plan_set(p jsonb)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare kv record; lim jsonb := '{"adu_window_days":[7,120],"safety_days":[0,30],"review_days":[1,60],"default_lead_days":[0,60],"oil_lot_g":[1,5000],"emp_lot":[1,1000]}';
begin
  if my_role() is distinct from 'owner' then raise exception 'not_allowed'; end if;
  if p ? 'settings' then
    for kv in select key, value from jsonb_each(p -> 'settings') loop
      if not lim ? kv.key or jsonb_typeof(kv.value) <> 'number' then raise exception 'bad_setting'; end if;
      if (kv.value)::text::numeric < (lim -> kv.key ->> 0)::numeric or (kv.value)::text::numeric > (lim -> kv.key ->> 1)::numeric then raise exception 'out_of_range'; end if;
      insert into plan_settings(k, v) values (kv.key, (kv.value)::text::numeric) on conflict (k) do update set v = excluded.v;
    end loop;
  end if;
  if p ? 'supplier' then
    insert into plan_supplier(supplier_id, lead_days) values ((p -> 'supplier' ->> 'id')::uuid, (p -> 'supplier' ->> 'lead_days')::numeric)
      on conflict (supplier_id) do update set lead_days = excluded.lead_days;
  end if;
  if p ? 'item' then
    insert into plan_item(kind, item_id, supplier_id, safety_days, lot_size, ignore)
      values (p -> 'item' ->> 'kind', (p -> 'item' ->> 'id')::uuid, nullif(p -> 'item' ->> 'supplier', '')::uuid,
              nullif(p -> 'item' ->> 'safety_days', '')::numeric, nullif(p -> 'item' ->> 'lot_size', '')::numeric, coalesce((p -> 'item' ->> 'ignore')::boolean, false))
      on conflict (kind, item_id) do update set supplier_id = excluded.supplier_id, safety_days = excluded.safety_days, lot_size = excluded.lot_size, ignore = excluded.ignore;
  end if;
  insert into audit_log(user_id, action, detail) values (auth.uid(), 'plan_set', p);
end $function$;

revoke all on function public.plan_status() from public, anon;
revoke all on function public.plan_po_create(uuid, jsonb, text) from public, anon;
revoke all on function public.plan_po_close(uuid, text, uuid) from public, anon;
revoke all on function public.plan_set(jsonb) from public, anon;
grant execute on function public.plan_status() to authenticated;
grant execute on function public.plan_po_create(uuid, jsonb, text) to authenticated;
grant execute on function public.plan_po_close(uuid, text, uuid) to authenticated;
grant execute on function public.plan_set(jsonb) to authenticated;

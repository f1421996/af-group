-- Price tiers, step 2. Additive: replaces the not-yet-used tier_pricelist and adds tier_quote for the invoice.
-- price_tiers itself (table + 5 rows + RLS) was created earlier the same day and is not changed here.
-- Rules kept from the approved plan: tier price = list - fixed discount, never below ceil((cost + margin)/5)*5,
-- never above list. Two fixes: (1) a page with no price of its own for an item falls back to the OL price, exactly
-- like the invoice does; (2) an item with no known cost gets NO discount (it has no floor to protect it).
-- Cost never leaves the database: both functions return prices only.

create or replace function public.tier_pricelist(p_page text, p_tier int)
returns table(brand text, name text, size_ml numeric, code text, list_price numeric, price numeric)
language plpgsql stable security definer set search_path to 'public' as $function$
declare t price_tiers;
begin
  if not page_ok(p_page) then raise exception 'not allowed'; end if;
  select * into t from price_tiers where no = p_tier;
  if not found then raise exception 'tier not found'; end if;
  return query
  with it as (
    select p.brand::text b, p.name::text n, p.size_ml::numeric s, p.code::text c, coalesce(pp.price, po.price)::numeric lst,
      case when p.brand = 'بوكسات' or trim(p.name) = 'شنط مزايا' then 'f'
           when p.size_ml = 30 then 's' when p.size_ml >= 200 then 'l' else 'm' end k, p.id
    from products p
    left join product_prices pp on pp.product_id = p.id and pp.page_id = p_page
    left join product_prices po on po.product_id = p.id and po.page_id = 'ol'
    where p.in_pricelist and not coalesce(p.hidden, false) and coalesce(pp.price, po.price) is not null),
  c as (
    select it.*, unit_cost(it.id, case it.k when 's' then 3 when 'l' then 20 else case when it.s <= 75 then 7 else 10 end end) uc from it)
  select c.b, c.n, c.s, c.c, c.lst,
    case when c.k = 'f' or t.no = 1 or c.uc is null then c.lst
    else least(c.lst, greatest(
      c.lst - case c.k when 'm' then t.disc_100 when 'l' then t.disc_200 else t.disc_30 end,
      ceil((c.uc + case when c.k = 's' then t.margin_30 else t.margin_100 end) / 5.0) * 5)) end
  from c order by c.b, c.c;
end $function$;

-- Invoice helper. p_lines: [{i, pid, qty, g}] (g = grams per piece on that line, may be null).
-- The tier comes from the total pieces of the invoice. The floor uses the cost at the line's own grams,
-- so a stronger concentration is protected by a higher floor without any extra pricing rule.
-- Returns {total, tier, lines:[{i, base, price, why}]}  why: ok | floor | fixed | nocost | noprice
create or replace function public.tier_quote(p_page text, p_lines jsonb)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare t price_tiers; tot numeric; res jsonb;
begin
  if not page_ok(p_page) then raise exception 'not allowed'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'no_lines'; end if;
  if jsonb_array_length(p_lines) > 600 then raise exception 'too_many_lines'; end if;
  select coalesce(sum(x.qty), 0) into tot from jsonb_to_recordset(p_lines) as x(qty numeric) where x.qty > 0;
  select * into t from price_tiers where min_qty <= tot order by no desc limit 1;
  if not found then select * into t from price_tiers order by no limit 1; end if;
  if not found then raise exception 'tier not found'; end if;
  with ln as (
    select x.i, x.pid, x.g, p.size_ml s, coalesce(pp.price, po.price)::numeric lst,
      case when p.id is null then 'x' when p.brand = 'بوكسات' or trim(p.name) = 'شنط مزايا' then 'f'
           when p.size_ml = 30 then 's' when p.size_ml >= 200 then 'l' else 'm' end k
    from jsonb_to_recordset(p_lines) as x(i int, pid uuid, qty numeric, g numeric)
    left join products p on p.id = x.pid
    left join product_prices pp on pp.product_id = x.pid and pp.page_id = p_page
    left join product_prices po on po.product_id = x.pid and po.page_id = 'ol'),
  c as (
    select ln.*, case when ln.k in ('x', 'f') or ln.lst is null then null else
      unit_cost(ln.pid, coalesce(nullif(ln.g, 0), case ln.k when 's' then 3 when 'l' then 20 else case when ln.s <= 75 then 7 else 10 end end)) end uc from ln),
  d as (
    select c.*, c.lst - case c.k when 'm' then t.disc_100 when 'l' then t.disc_200 when 's' then t.disc_30 else 0 end disc_p,
      ceil((c.uc + case when c.k = 's' then t.margin_30 else t.margin_100 end) / 5.0) * 5 flr from c)
  select jsonb_build_object('total', tot, 'tier', t.no,
    'lines', coalesce(jsonb_agg(jsonb_build_object('i', d.i, 'base', d.lst,
      'price', case when d.lst is null then null when d.k = 'f' or t.no = 1 or d.uc is null then d.lst else least(d.lst, greatest(d.disc_p, d.flr)) end,
      'why', case when d.lst is null then 'noprice' when d.k = 'f' then 'fixed' when d.uc is null then 'nocost'
                  when t.no > 1 and d.flr > d.disc_p then 'floor' else 'ok' end) order by d.i), '[]'))
    into res from d;
  return res;
end $function$;

revoke all on function public.tier_pricelist(text, int) from public, anon;
revoke all on function public.tier_quote(text, jsonb) from public, anon;
grant execute on function public.tier_pricelist(text, int) to authenticated;
grant execute on function public.tier_quote(text, jsonb) to authenticated;

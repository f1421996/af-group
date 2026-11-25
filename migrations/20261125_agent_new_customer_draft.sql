-- The assistant can prepare an invoice draft for a NEW customer. Nothing is created until the user presses
-- "سجّل الفاتورة": the customer is created by save_invoice at commit time, exactly like the invoice screen does.
-- Additive: agent_drafts.customer_id becomes nullable (a draft for a new customer has no id yet) + one new function.
alter table public.agent_drafts alter column customer_id drop not null;

create or replace function public.ag_draft_invoice_new(p_name text, p_phone text, p_addr text, p_items jsonb, p_page text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare r text := my_role(); pg text; nm text := btrim(coalesce(p_name, '')); ph text; ad text := btrim(coalesce(p_addr, ''));
  ex customers; it jsonb; i int := 0; best int; n_close int; pid uuid; lines jsonb := '[]'; issues jsonb := '[]';
  q numeric; pr numeric; src text; ap record; tot numeric := 0; did uuid; p products; g numeric;
begin
  if r is null or r not in ('owner', 'billing', 'page') then raise exception 'not_allowed'; end if;
  pg := case when r = 'page' then my_page() else nullif(lower(btrim(coalesce(p_page, ''))), '') end;
  if pg is null or not exists (select 1 from pages where id = pg) then
    return jsonb_build_object('error', 'محتاج أعرف الصفحة', 'pages', (select jsonb_agg(jsonb_build_object('id', id, 'name', short)) from pages),
      'STOP', 'اسأل المستخدم الفاتورة دي لأنهي صفحة، وابعت page بالـ id.');
  end if;
  if length(nm) < 2 then return jsonb_build_object('error', 'اسم العميل مش واضح', 'STOP', 'اسأل عن اسم العميل الأول.'); end if;
  ph := regexp_replace(translate(coalesce(p_phone, ''), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '[^0-9+]', '', 'g');
  if ph <> '' and length(regexp_replace(ph, '\D', '', 'g')) < 10 then
    return jsonb_build_object('error', 'رقم التليفون ناقص', 'phone', ph, 'STOP', 'اسأل عن الرقم الصح، أو يكمّل من غير رقم.');
  end if;
  -- the same person may already exist on this page: by phone first, then by exact name
  if length(regexp_replace(ph, '\D', '', 'g')) >= 10 then
    select * into ex from customers where page_id = pg and deleted_at is null
      and (right(regexp_replace(phone, '\D', '', 'g'), 10) = right(regexp_replace(ph, '\D', '', 'g'), 10)
        or right(regexp_replace(phone2, '\D', '', 'g'), 10) = right(regexp_replace(ph, '\D', '', 'g'), 10)) limit 1;
  end if;
  if ex.id is null then select * into ex from customers where page_id = pg and deleted_at is null and ag_norm(name) = ag_norm(nm) limit 1; end if;
  if ex.id is not null then
    return jsonb_build_object('status', 'customer_exists', 'customer', ex.name, 'phone', ex.phone,
      'STOP', 'العميل ده متسجل قبل كده. قول للمستخدم اسمه في السيستم واسأله لو هو نفسه، ولو أيوه استخدم draft_invoice باسمه.');
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then return jsonb_build_object('error', 'مفيش أصناف'); end if;
  if jsonb_array_length(p_items) > 60 then return jsonb_build_object('error', 'أقصى 60 صنف في المرة'); end if;

  for it in select * from jsonb_array_elements(p_items) loop
    i := i + 1; pid := null;
    q := nullif(regexp_replace(translate(coalesce(it->>'qty', ''), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '[^0-9.]', '', 'g'), '')::numeric;
    if q is null or q <= 0 then issues := issues || jsonb_build_object('line', i, 'asked', it->>'product', 'problem', 'الكمية مش واضحة'); continue; end if;
    select max(score) into best from ag_find_products(it->>'product', 6);
    if best is null then issues := issues || jsonb_build_object('line', i, 'asked', it->>'product', 'problem', 'الصنف مش موجود'); continue; end if;
    select count(*) into n_close from ag_find_products(it->>'product', 6) f where f.score >= best - 10;
    if best < 100 and n_close > 1 then
      issues := issues || jsonb_build_object('line', i, 'asked', it->>'product', 'problem', 'الاسم يطابق أكتر من صنف',
        'choose', (select jsonb_agg(p2.name || ' (F' || p2.cnt_no || ')') from ag_find_products(it->>'product', 6) f join products p2 on p2.id = f.id where f.score >= best - 10));
      continue;
    end if;
    select f.id into pid from ag_find_products(it->>'product', 1) f;
    select * into p from products where id = pid;
    select * into ap from ag_auto_price(null, pg, pid);
    if jsonb_typeof(it->'price') = 'number' then pr := (it->>'price')::numeric; src := 'سعر مكتوب';
    else pr := ap.price; src := ap.src; end if;
    if pr is null or pr < 0 then issues := issues || jsonb_build_object('line', i, 'asked', it->>'product', 'problem', 'مفيش سعر للصنف ده'); continue; end if;
    g := (select grams from product_recipe where product_id = pid);
    lines := lines || jsonb_build_object('asked', coalesce(nullif(it->>'said', ''), it->>'product'), 'product_id', pid, 'name', p.name, 'F', p.cnt_no,
      'qty', q, 'price', pr, 'price_src', src, 'g', g, 'sum', q * pr);
    tot := tot + q * pr;
  end loop;

  if jsonb_array_length(issues) > 0 then
    return jsonb_build_object('status', 'needs_answers', 'customer', nm, 'new_customer', true, 'ready_lines', lines, 'issues', issues,
      'STOP', 'في أصناف مش واضحة. اسأل عنها كلها الأول. ماتقولش إن الفاتورة جاهزة.');
  end if;
  insert into agent_drafts(user_id, page_id, customer_id, cust, lines, total, asked_customer)
    values (auth.uid(), pg, null, jsonb_build_object('id', null, 'name', nm, 'phone', ph, 'phone2', '', 'addr', ad), lines, tot, null)
    returning id into did;
  return jsonb_build_object('status', 'draft_ready', 'draft_id', did, 'customer', nm, 'new_customer', true, 'phone', ph, 'addr', ad,
    'page', (select short from pages where id = pg), 'lines', lines, 'total', tot,
    'NOTE', 'المسودة جاهزة ومتسجلتش، والعميل الجديد هيتسجل مع الفاتورة لما المستخدم يدوس «سجّل الفاتورة». ماتقولش إنها اتسجلت.');
end $function$;

revoke all on function public.ag_draft_invoice_new(text, text, text, jsonb, text) from public, anon;
grant execute on function public.ag_draft_invoice_new(text, text, text, jsonb, text) to authenticated;

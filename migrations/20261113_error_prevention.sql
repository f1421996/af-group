-- Error prevention (2026-11-13)
-- 1) A supplier invoice can't be saved/edited with totals that disagree with its lines.
--    Checked at COMMIT (deferred) so save_supplier_invoice can insert header + lines first.
--    Only fires when subtotal/discount/total are written, so old rows stay untouched until edited.
-- 2) A product recipe can't point at an inactive (e.g. merged) oil.

create or replace function public.trg_supplier_invoice_check()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare ls numeric; ln numeric;
begin
  if new.void then return null; end if;
  select coalesce(sum(line_total),0), coalesce(sum(net_total),0)
    into ls, ln from supplier_invoice_lines where invoice_id = new.id;
  if abs(new.subtotal - ls) > 0.05 or abs(new.total - ln) > 0.05 then
    raise exception 'supplier_invoice_totals_mismatch: subtotal % vs lines %, total % vs lines %',
      new.subtotal, ls, new.total, ln;
  end if;
  return null;
end $$;

drop trigger if exists supplier_invoice_check on public.supplier_invoices;
create constraint trigger supplier_invoice_check
  after insert or update of subtotal, discount, total on public.supplier_invoices
  deferrable initially deferred
  for each row execute function public.trg_supplier_invoice_check();

create or replace function public.trg_recipe_oil_active()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.oil_id is not null
     and not exists (select 1 from materials where id = new.oil_id and active) then
    raise exception 'recipe_oil_inactive';
  end if;
  return new;
end $$;

drop trigger if exists recipe_oil_active on public.product_recipe;
create trigger recipe_oil_active
  before insert or update of oil_id on public.product_recipe
  for each row execute function public.trg_recipe_oil_active();

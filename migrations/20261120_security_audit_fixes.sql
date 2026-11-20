-- Applied to production 2026-11-20 (migration security_audit_fixes_20261120) after the full audit.
-- 1) product_prices: a signed-in user with no active profile (role NULL) could read THE OUTLET price list,
--    because "role IS DISTINCT FROM 'maker'" is true for NULL. Only real page users may use that branch.
drop policy if exists prices_read on public.product_prices;
create policy prices_read on public.product_prices for select to authenticated using (
  ((select my_role()) = any (array['owner','billing','stock']))
  or ((select my_role()) = 'page' and page_id = any (array[(select my_page()), 'ol'])));

-- 2) pin the search_path of the two functions the linter flagged
alter function public.guess_family(text) set search_path to 'public', 'extensions';
alter function public.trg_product_family() set search_path to 'public', 'extensions';

-- 3) two supplier invoices had a wrong stored subtotal (lines and totals were already correct)
update public.supplier_invoices si
   set subtotal = (select sum(line_total) from public.supplier_invoice_lines l where l.invoice_id = si.id)
 where not void
   and abs(subtotal - (select sum(line_total) from public.supplier_invoice_lines l where l.invoice_id = si.id)) > 1
   and abs(total - (select sum(net_total) from public.supplier_invoice_lines l where l.invoice_id = si.id)) <= 0.05;

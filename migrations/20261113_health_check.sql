-- Daily health check: returns one row per check. severity 'fail' = real data problem.
create or replace function public.health_check()
returns table(check_name text, severity text, n bigint, detail text)
language sql
security definer
set search_path to 'public'
as $$
  with c as (
    select 'سطور فواتير بدون فاتورة' nm, 'fail' sv, count(*) n, null::text d
      from invoice_lines l left join invoices i on i.id=l.invoice_id where i.id is null
    union all select 'سطور فواتير بدون منتج','fail',count(*),null
      from invoice_lines l left join products p on p.id=l.product_id where p.id is null
    union all select 'سطور نشطة كميتها صفر أو سعرها سالب','fail',count(*),null
      from invoice_lines where active and removed_at is null and (qty<=0 or price<0)
    union all select 'alias على alias','fail',count(*),null
      from products p join products m on m.id=p.stock_of where m.stock_of is not null
    union all select 'alias عليه رصيد غير صفر','fail',count(*),null
      from products p join product_stock s on s.product_id=p.id where p.stock_of is not null and s.qty<>0
    union all select 'منتجات بدون سجل مخزن','fail',count(*),null
      from products p left join product_stock s on s.product_id=p.id where s.product_id is null
    union all select 'وصفات على زيت غير موجود','fail',count(*),null
      from product_recipe r left join materials m on m.id=r.oil_id where r.oil_id is not null and m.id is null
    union all select 'وصفات على زيت غير نشط (مدموج؟)','warn',count(*),
        (select string_agg(p.name, ' | ') from product_recipe r join materials m on m.id=r.oil_id join products p on p.id=r.product_id where not m.active)
      from product_recipe r join materials m on m.id=r.oil_id where not m.active
    union all select 'فواتير مورد: الإجمالي مش مساوي مجموع السطور','fail',count(*),
        (select string_agg(coalesce(si.number,'بدون رقم')||' ('||si.date||')', ' | ') from supplier_invoices si
          where not si.void and abs(si.total-(select coalesce(sum(net_total),0) from supplier_invoice_lines l where l.invoice_id=si.id))>0.05)
      from supplier_invoices si
      where not si.void and abs(si.total-(select coalesce(sum(net_total),0) from supplier_invoice_lines l where l.invoice_id=si.id))>0.05
    union all select 'فواتير مورد: subtotal غلط (معروفة، لسه ما اتصلحتش)','warn',count(*),null
      from supplier_invoices si
      where not si.void and abs(si.subtotal-(select coalesce(sum(line_total),0) from supplier_invoice_lines l where l.invoice_id=si.id))>1
    union all select 'دفعات بدون عميل','fail',count(*),null
      from payments p left join customers c on c.id=p.customer_id where c.id is null
    union all select 'أرقام فواتير مكررة','fail',count(*),null
      from (select page_id,no from invoices group by 1,2 having count(*)>1) x
    union all select 'أكواد جرد مكررة','fail',count(*),null
      from (select cnt_no from products where cnt_no is not null group by 1 having count(*)>1
            union all select cnt_no from materials where cnt_no is not null group by 1 having count(*)>1) x
    union all select 'زيوت نشطة رصيدها سالب (نقص)','info',count(*),null
      from materials where active and stock<0
    union all select 'سطور في أوردرات مفتوحة ناقصها تركيز (بتظهر ⚠️ في الشاشة)','info',count(*),
        (select string_agg(i2.no||' '||l2.name, ' | ') from invoice_lines l2 join invoices i2 on i2.id=l2.invoice_id join product_recipe r2 on r2.product_id=l2.product_id where l2.active and l2.removed_at is null and coalesce(l2.grams,0)=0 and r2.oil_id is not null and i2.deleted_at is null and i2.fulfilled_at is null and not l2.mat_done)
      from invoice_lines l join invoices i on i.id=l.invoice_id join product_recipe r on r.product_id=l.product_id
      where l.active and l.removed_at is null and coalesce(l.grams,0)=0 and r.oil_id is not null
        and i.deleted_at is null and i.fulfilled_at is null and not l.mat_done
  )
  select nm, sv, n, d from c order by case sv when 'fail' then 0 when 'warn' then 1 else 2 end, nm;
$$;
revoke all on function public.health_check() from public, anon, authenticated;

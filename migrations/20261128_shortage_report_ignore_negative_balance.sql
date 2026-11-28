-- Shortage report: a negative recorded balance is an old recording gap (goods of closed orders that left without
-- a purchase being recorded). The shelf cannot hold less than zero, so the shortage for OPEN orders is need - max(have, 0).
-- 'have' is still returned as recorded so the screen can show the gap. Patched in place (function body otherwise unchanged).
do $$
declare d text := pg_get_functiondef('public.shortage_report(uuid[])'::regprocedure); n int;
  reps text[][] := array[
    ['''short'',e.need-e.have,', '''short'',e.need-greatest(e.have,0),'],
    ['order by e.need-e.have desc) from e join products p on p.id=e.mid where e.need>e.have)', 'order by e.need-greatest(e.have,0) desc) from e join products p on p.id=e.mid where e.need>greatest(e.have,0))'],
    ['''short'',o.need-round(m.stock),', '''short'',o.need-greatest(round(m.stock),0),'],
    ['order by o.need-m.stock desc) from o join materials m on m.id=o.oil_id where o.need>m.stock)', 'order by o.need-greatest(m.stock,0) desc) from o join materials m on m.id=o.oil_id where o.need>greatest(m.stock,0))']];
begin
  for i in 1..4 loop
    n := (length(d) - length(replace(d, reps[i][1], ''))) / length(reps[i][1]);
    if n <> 1 then raise exception 'anchor % found % times', i, n; end if;
    d := replace(d, reps[i][1], reps[i][2]);
  end loop;
  execute d;
end $$;

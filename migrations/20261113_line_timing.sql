-- Work timing capture (phase 1 of technician performance).
-- Records every "خلصته" made live (done_at = now()) together with the worker's own "ابدأ" time,
-- which check_lines clears in the same UPDATE. Nothing in invoices/stock logic is changed.
-- Re-applied historical done marks (save_invoice re-attaching old done_at) are ignored.

create table if not exists public.line_timing (
  id          bigint generated always as identity primary key,
  line_id     uuid not null,
  invoice_id  uuid not null,
  product_id  uuid,
  worker_id   uuid,
  worker_name text,
  qty         numeric not null,
  grams       numeric,
  started_at  timestamptz,          -- worker's own "ابدأ"; null if they didn't press it
  done_at     timestamptz not null,
  inv_lines   int,                  -- active lines in the order at that moment
  inv_pieces  numeric,              -- total pieces in the order at that moment
  undone_at   timestamptz,          -- set if the line is un-checked later
  created_at  timestamptz not null default now()
);
create index if not exists line_timing_worker_done_idx on public.line_timing (worker_id, done_at);
create index if not exists line_timing_product_idx on public.line_timing (product_id);
create index if not exists line_timing_line_idx on public.line_timing (line_id);
alter table public.line_timing enable row level security;   -- no policies: owner reads via SQL/functions only

create or replace function public.trg_line_timing()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.done_at is null and new.done_at is not null and new.done_at = now() then
    insert into line_timing(line_id, invoice_id, product_id, worker_id, worker_name, qty, grams,
                            started_at, done_at, inv_lines, inv_pieces)
    select new.id, new.invoice_id, new.product_id, new.done_by, new.done_name, new.qty,
           coalesce(new.grams_actual, new.grams),
           case when old.claim_by is not distinct from new.done_by then old.claim_at end,
           new.done_at,
           (select count(*) from invoice_lines x where x.invoice_id = new.invoice_id and x.active),
           (select coalesce(sum(qty),0) from invoice_lines x where x.invoice_id = new.invoice_id and x.active);
  elsif old.done_at is not null and new.done_at is null then
    update line_timing set undone_at = now() where line_id = new.id and undone_at is null;
  end if;
  return null;
end $$;

drop trigger if exists line_timing_capture on public.invoice_lines;
create trigger line_timing_capture
  after update of done_at on public.invoice_lines
  for each row execute function public.trg_line_timing();

revoke all on function public.trg_line_timing() from public, anon, authenticated;
revoke all on table public.line_timing from anon, authenticated;

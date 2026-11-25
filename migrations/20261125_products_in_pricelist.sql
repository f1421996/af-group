-- Additive: lets the owner keep an item out of the printed price list. Default true = nothing changes for existing items.
alter table public.products add column if not exists in_pricelist boolean not null default true;
-- Applied with it: in_pricelist = false for the 10 same-empty variants the owner approved (2026-11-25).

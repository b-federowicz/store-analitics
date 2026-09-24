-- 1. Products table
create table products (
    product_id bigint primary key,                  -- BaseLinker's own product_id, used directly (no local identity generation)
    ean text,
    sku text not null,                              -- raw BaseLinker SKU, e.g. A00163-01
    matched_sheet_sku text,                         -- the Google Sheet SKU it was prefix-matched against, e.g. A00163 (null if unmatched)
    product_cost_netto numeric(12, 2) not null default 0,
    cost_updated_at timestamptz,                    -- last time the sheet match/price was refreshed
    created_at timestamptz not null default now()
);

-- 2. Orders table
create table orders (
    order_id bigint primary key,                    -- BaseLinker's own order_id, used directly (no local identity generation)
    external_order_id text,                          -- marketplace's own order id (e.g. MediaExpert order number)
    order_source bigint,                              -- BaseLinker's order_source_id (not the order_source type string) — the same marketplace/type can have multiple accounts sharing one type, so the id is the only stable per-account key. Resolved to a display name via order_sources.
    delivery_nr text,
    delivery_country_code text,                       -- e.g. "PL", "DE" — drives vat_rate on line items
    currency text,                                    -- e.g. "PLN", "EUR" — sync skips non-PLN orders, kept for visibility
    delivery_cost_netto numeric(12, 2) default 0,    -- filled later from CSV import
    revenue_brutto numeric(12, 2) not null default 0,   -- BaseLinker order total minus customer-paid shipping, computed in the sync function
    revenue_netto numeric(12, 2) default 0,             -- sum of line items' netto, filled by trigger
    fees_brutto numeric(12, 2) default 0,
    fees_netto numeric(12, 2) default 0,               -- summed from BaseLinker's commissions[] array
    marketing_cost numeric(12, 2) not null default 0,  -- filled later from CSV import
    profit numeric(12, 2) default 0,                         -- auto-calculated by trigger, see below
    order_date date not null default current_date,
    more_info_link text,
    created_at timestamptz not null default now(),
    products_cost numeric default 0,
    margin numeric(10, 2),                                   -- profit / revenue_netto * 100, auto-calculated by trigger, see below
    has_skipped_lines boolean not null default false          -- true if the last BaseLinker sync couldn't store one or more of this order's lines (bad id/quantity) — products_cost/profit are understated until resolved
);

-- 2b. Order sources: BaseLinker's order_source_id -> account name/type, refreshed
-- once per order sync (not per page load) via getOrderSources.
create table order_sources (
    source_id bigint primary key,                    -- BaseLinker's order_source_id
    source_type text not null,                        -- BaseLinker's order_source, e.g. "tergpl", "allegro", "amazon" — shared by every account of that type
    name text not null,                                -- account/site name from getOrderSources, e.g. "moje.allegro.pl (login)"
    updated_at timestamptz not null default now()
);

-- 3. Order_products (junction table, many-to-many, VAT rate lives here per line)
create table order_products (
    order_product_id bigint primary key,            -- BaseLinker's own order_product_id, used directly (no local identity generation)
    order_id bigint not null references orders(order_id) on delete cascade,
    product_id bigint not null references products(product_id) on delete restrict,  -- same value as BaseLinker's product_id, shared with products.product_id
    baselinker_sku text not null,                                          -- raw SKU as received from BaseLinker, always stored regardless of match status
    quantity integer not null check (quantity > 0),
    vat_rate numeric(5, 4) not null default 0.23,             -- per line, since BaseLinker can mix rates
    price_brutto numeric(12, 2) not null,                     -- per unit, brutto, as sent by BaseLinker
    price_netto numeric(12, 2)
        generated always as (round(price_brutto / (1 + vat_rate), 2)) stored,
    created_at timestamptz not null default now()
);

-- delivery_nr is looked up on every stage_delivery_cost upsert (cost-push
-- trigger below) and by the dashboard matched/unmatched EXISTS subqueries.
create index idx_orders_delivery_nr on orders(delivery_nr);

create index idx_order_products_order_id on order_products(order_id);
create index idx_order_products_product_id on order_products(product_id);
create index idx_order_products_baselinker_sku on order_products(baselinker_sku);

-- Function + trigger: recalculate revenue_netto and profit
-- whenever order_products rows change, or when commission/delivery on the order changes
create or replace function recalc_order_profit(p_order_id bigint)
returns void
language plpgsql
as $$
declare
    v_price_netto numeric(12,2);
    v_price_brutto numeric(12,2);
    v_vat_rate numeric(5,4);
    v_product_cost numeric(12,2);
    v_delivery numeric(12,2);
    v_commission numeric(12,2);
    v_marketing numeric(12,2);
    v_profit numeric(12,2);
begin
    -- revenue_netto is derived from the order-level BaseLinker brutto total
    -- (revenue_brutto), not summed from order_products lines — a single
    -- order can be missing lines (see order_products cleanup) without that
    -- affecting revenue, since revenue is what the customer actually paid.
    select revenue_brutto into v_price_brutto
    from orders
    where order_id = p_order_id;

    select max(op.vat_rate) into v_vat_rate
    from order_products op
    where op.order_id = p_order_id;

    v_price_netto := round(coalesce(v_price_brutto, 0) / (1 + coalesce(v_vat_rate, 0.23)), 2);

    -- products with no sheet match yet have product_cost_netto = 0, so they contribute 0 cost until priced
    select coalesce(sum(p.product_cost_netto * op.quantity), 0)
    into v_product_cost
    from order_products op
    join products p on p.product_id = op.product_id
    where op.order_id = p_order_id;

    select delivery_cost_netto, fees_netto, marketing_cost
    into v_delivery, v_commission, v_marketing
    from orders
    where order_id = p_order_id;

    v_profit := round(v_price_netto - v_product_cost - coalesce(v_delivery, 0) - coalesce(v_commission, 0) - coalesce(v_marketing, 0), 2);

    update orders
    set revenue_netto = v_price_netto,
        products_cost = v_product_cost,
        profit = v_profit,
        margin = round(v_profit / nullif(v_price_netto, 0) * 100, 2)
    where order_id = p_order_id;
end;
$$;

-- Set-based counterpart of recalc_order_profit for bulk recalculation
-- (invoke-function's "recalculate all" flow). Recomputes an entire batch of
-- orders in one statement instead of one round trip per order_id — the
-- per-order RPC loop this replaced took tens of minutes for large batches
-- and could eventually hit statement_timeout on a single call, discarding
-- all prior progress since the caller has nothing to resume from.
create or replace function recalc_order_profit_bulk(p_order_ids bigint[])
returns void
language plpgsql
as $$
begin
    with line_costs as (
        select op.order_id,
               max(op.vat_rate) as vat_rate,
               coalesce(sum(p.product_cost_netto * op.quantity), 0) as product_cost
        from order_products op
        join products p on p.product_id = op.product_id
        where op.order_id = any(p_order_ids)
        group by op.order_id
    ),
    calc as (
        select o.order_id,
               round(coalesce(o.revenue_brutto, 0) / (1 + coalesce(lc.vat_rate, 0.23)), 2) as price_netto,
               coalesce(lc.product_cost, 0) as product_cost,
               o.delivery_cost_netto,
               o.fees_netto,
               o.marketing_cost
        from orders o
        left join line_costs lc on lc.order_id = o.order_id
        where o.order_id = any(p_order_ids)
    ),
    final as (
        select order_id,
               price_netto,
               product_cost,
               round(price_netto - product_cost - coalesce(delivery_cost_netto, 0) - coalesce(fees_netto, 0) - coalesce(marketing_cost, 0), 2) as profit
        from calc
    )
    update orders o
    set revenue_netto = f.price_netto,
        products_cost = f.product_cost,
        profit = f.profit,
        margin = round(f.profit / nullif(f.price_netto, 0) * 100, 2)
    from final f
    where o.order_id = f.order_id;
end;
$$;

-- Trigger on order_products: fires on insert/update/delete
create or replace function trg_order_products_recalc()
returns trigger
language plpgsql
as $$
begin
    if TG_OP = 'DELETE' then
        perform recalc_order_profit(old.order_id);
        return old;
    else
        perform recalc_order_profit(new.order_id);
        return new;
    end if;
end;
$$;

create trigger order_products_after_change
after insert or update or delete on order_products
for each row execute function trg_order_products_recalc();

-- Trigger on orders: fires if delivery_cost_netto or fees_netto change directly
create or replace function trg_orders_recalc()
returns trigger
language plpgsql
as $$
begin
    if new.delivery_cost_netto is distinct from old.delivery_cost_netto
       or new.fees_netto is distinct from old.fees_netto
       or new.marketing_cost is distinct from old.marketing_cost then
        perform recalc_order_profit(new.order_id);
    end if;
    return new;
end;
$$;

create trigger orders_after_update
after update on orders
for each row execute function trg_orders_recalc();

-- Trigger on products: fires when product_cost_netto changes (e.g. Google Sheet cost import),
-- recalculating profit for every order line that references this product
create or replace function trg_products_recalc()
returns trigger
language plpgsql
as $$
declare
    r record;
begin
    if new.product_cost_netto is distinct from old.product_cost_netto then
        for r in
            select distinct order_id from order_products where product_id = new.product_id
        loop
            perform recalc_order_profit(r.order_id);
        end loop;
    end if;
    return new;
end;
$$;

create trigger products_after_update
after update on products
for each row execute function trg_products_recalc();

-- 4. Stage table for delivery cost CSV imports (InPost, DPD, ...)
-- nr is the carrier's own package/shipment number, used as the natural key
-- so re-importing the same CSV just upserts instead of duplicating rows.
create table stage_delivery_cost (
    nr text primary key,
    netto numeric(10, 2),
    brutto numeric(10, 2)
);

-- Trigger on stage_delivery_cost: fires on insert/update (CSV upsert), pushes
-- the netto cost onto any order whose delivery_nr matches this shipment nr.
-- Updating orders.delivery_cost_netto in turn fires trg_orders_recalc, so
-- profit/margin recalculate automatically without invoke-function needing to run.
--
-- Statement-level (not row-level): a CSV import upserts thousands of rows in one
-- statement, and a per-row UPDATE ... WHERE delivery_nr = ... would run one
-- orders scan per row. Here the whole batch is joined against orders once via
-- the NEW transition table. The `is distinct from` guard also covers the old
-- "skip UPDATE when netto didn't change" case — an unchanged netto means orders
-- already holds that value, so nothing is written.
create or replace function trg_stage_delivery_cost_push()
returns trigger
language plpgsql
as $$
begin
    update orders o
    set delivery_cost_netto = n.netto
    from new_rows n
    where o.delivery_nr = n.nr
      and o.delivery_cost_netto is distinct from n.netto;

    return null;
end;
$$;

create trigger stage_delivery_cost_after_insert
after insert on stage_delivery_cost
referencing new table as new_rows
for each statement execute function trg_stage_delivery_cost_push();

create trigger stage_delivery_cost_after_update
after update on stage_delivery_cost
referencing new table as new_rows
for each statement execute function trg_stage_delivery_cost_push();

-- Row Level Security
alter table products enable row level security;
alter table orders enable row level security;
alter table order_sources enable row level security;
alter table order_products enable row level security;
alter table stage_delivery_cost enable row level security;

create policy "Allow authenticated read access on products"
    on products for select to authenticated using (true);

create policy "Allow authenticated read access on orders"
    on orders for select to authenticated using (true);

create policy "Allow authenticated read access on order_sources"
    on order_sources for select to authenticated using (true);

create policy "Allow authenticated read access on order_products"
    on order_products for select to authenticated using (true);

create policy "Allow authenticated read access on stage_delivery_cost"
    on stage_delivery_cost for select to authenticated using (true);


-- Dashboard RPCs: aggregate the summary/trend/unmatched-rows 
-- paginated orders query in src/app/api/dashboard/route.ts

-- dropped first: CREATE OR REPLACE cannot add a new output column to an
-- existing table-returning function's signature
drop function if exists dashboard_summary(date, date, bigint[], text);

create or replace function dashboard_summary(
    p_from date,
    p_to date,
    p_source_ids bigint[],
    p_transaction_type text default null
)
returns table (
    total_orders bigint,
    total_profit numeric,
    total_revenue_netto numeric,
    total_revenue_brutto numeric,
    total_delivery_cost numeric,
    total_commission numeric,
    total_product_cost numeric,
    total_marketing_cost numeric,
    matched_delivery_count bigint,
    unmatched_db_order_count bigint,
    unmatched_csv_row_count bigint
)
language sql
stable
as $$
    select
        count(*),
        coalesce(round(sum(o.profit), 2), 0),
        coalesce(round(sum(o.revenue_netto), 2), 0),
        coalesce(round(sum(o.revenue_brutto), 2), 0),
        coalesce(round(sum(o.delivery_cost_netto), 2), 0),
        coalesce(round(sum(o.fees_netto), 2), 0),
        coalesce(round(sum(o.products_cost), 2), 0),
        coalesce(round(sum(o.marketing_cost), 2), 0),
        count(*) filter (
            where o.delivery_nr is not null
              and exists (select 1 from stage_delivery_cost s where s.nr = o.delivery_nr)
        ),
        count(*) filter (
            where not (
                o.delivery_nr is not null
                and exists (select 1 from stage_delivery_cost s where s.nr = o.delivery_nr)
            )
        ),
        (
            select count(*)
            from stage_delivery_cost s
            where not exists (
                select 1 from orders o2
                where o2.delivery_nr = s.nr
                  and (p_from is null or o2.order_date >= p_from)
                  and (p_to is null or o2.order_date <= p_to)
                  and (p_source_ids is null or o2.order_source = any(p_source_ids))
                  and (p_transaction_type is null or o2.transaction_type = p_transaction_type)
            )
        )
    from orders o
    where (p_from is null or o.order_date >= p_from)
      and (p_to is null or o.order_date <= p_to)
      and (p_source_ids is null or o.order_source = any(p_source_ids))
      and (p_transaction_type is null or o.transaction_type = p_transaction_type)
$$;

create or replace function dashboard_profit_by_date(
    p_from date,
    p_to date,
    p_source_ids bigint[],
    p_transaction_type text default null
)
returns table (
    date date,
    profit numeric,
    orders bigint
)
language sql
stable
as $$
    select
        o.order_date as date,
        round(sum(o.profit), 2) as profit,
        count(*) as orders
    from orders o
    where (p_from is null or o.order_date >= p_from)
      and (p_to is null or o.order_date <= p_to)
      and (p_source_ids is null or o.order_source = any(p_source_ids))
      and (p_transaction_type is null or o.transaction_type = p_transaction_type)
    group by o.order_date
    order by o.order_date asc
$$;

-- Orders in range with no matching stage_delivery_cost row — the only
-- orders the client actually needs full rows for (matched orders are
-- represented by matched_delivery_count above, never listed individually).
create or replace function dashboard_unmatched_orders(
    p_from date,
    p_to date,
    p_source_ids bigint[],
    p_transaction_type text default null
)
returns setof orders
language sql
stable
as $$
    select o.*
    from orders o
    where (p_from is null or o.order_date >= p_from)
      and (p_to is null or o.order_date <= p_to)
      and (p_source_ids is null or o.order_source = any(p_source_ids))
      and (p_transaction_type is null or o.transaction_type = p_transaction_type)
      and not exists (select 1 from stage_delivery_cost s where s.nr = o.delivery_nr)
    order by o.order_date desc, o.order_id asc
$$;

-- CSV rows not referenced by any order currently in range — mirrors the
-- same (from, to, source_ids, transaction_type) filter so it stays scoped
-- to what's on screen.
create or replace function dashboard_unmatched_csv_rows(
    p_from date,
    p_to date,
    p_source_ids bigint[],
    p_transaction_type text default null
)
returns setof stage_delivery_cost
language sql
stable
as $$
    select s.*
    from stage_delivery_cost s
    where not exists (
        select 1 from orders o
        where o.delivery_nr = s.nr
          and (p_from is null or o.order_date >= p_from)
          and (p_to is null or o.order_date <= p_to)
          and (p_source_ids is null or o.order_source = any(p_source_ids))
          and (p_transaction_type is null or o.transaction_type = p_transaction_type)
    )
$$;

-- Migration: run against an existing DB (this file as a whole is a
-- from-scratch schema dump, not idempotent). Flags orders whose last
-- BaseLinker sync couldn't store one or more lines (bad id/quantity),
-- since products_cost/profit are computed only from stored order_products
-- rows and silently understate cost for such orders.
alter table orders add column if not exists has_skipped_lines boolean not null default false;
alter table orders add column if not exists transaction_type text default 'Sprzedaż';
alter table orders add column if not exists marketing_cost numeric(12, 2) not null default 0;
alter table stage_delivery_cost add column if not exists shipment_ID numeric default null;
ALTER TABLE stage_delivery_cost ADD COLUMN IF NOT EXISTS date_confirm DATE;

-- Migration: rename orders columns to match frontend naming (run once
-- against an existing DB, before deploying app code that expects the
-- new names).
alter table orders rename column order_price_netto to revenue_netto;
alter table orders rename column order_price_brutto to revenue_brutto;
alter table orders rename column commission_netto to fees_netto;
alter table orders rename column commission_brutto to fees_brutto;
alter table orders rename column total_cost to products_cost;
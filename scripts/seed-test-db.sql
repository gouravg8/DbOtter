-- Test data for the integration and e2e tests (scripts/test-db.sh runs this).
-- A "shop" database with several schemas, a view, a materialized view, awkward names,
-- most common types, NULLs, and a 1M-row table.

CREATE DATABASE shop;
\c shop

CREATE SCHEMA sales;

CREATE TABLE public.customers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE,
  country text,
  vip boolean DEFAULT false,
  meta jsonb,
  tags text[],
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.customers IS 'People who bought something';
COMMENT ON COLUMN public.customers.vip IS 'Gets free shipping';

INSERT INTO public.customers (name, email, country, vip, meta, tags, created_at)
SELECT 'Customer ' || g, 'c' || g || '@example.com',
  (ARRAY['India', 'USA', 'Germany', 'Brazil', NULL])[1 + g % 5], g % 7 = 0,
  CASE WHEN g % 3 = 0 THEN jsonb_build_object('plan', 'pro', 'seats', g % 10) END,
  ARRAY['tag' || (g % 4)], now() - (g || ' hours')::interval
FROM generate_series(1, 2500) g;
-- quotes and LIKE wildcards in a value
INSERT INTO public.customers (name, email) VALUES ('O''Brien "the 50%_off" guy', 'ob@example.com');

CREATE TABLE sales.orders (
  id bigserial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES public.customers (id),
  amount numeric(10, 2) NOT NULL CHECK (amount >= 0),
  status text NOT NULL DEFAULT 'new',
  placed_at timestamptz NOT NULL DEFAULT now(),
  note text,
  uid uuid DEFAULT gen_random_uuid(),
  payload bytea
);
CREATE INDEX orders_customer_idx ON sales.orders (customer_id);
CREATE INDEX orders_status_idx ON sales.orders (status) WHERE status <> 'done';

INSERT INTO sales.orders (customer_id, amount, status, placed_at, note, payload)
SELECT 1 + g % 2500, (g % 1000) / 3.0, (ARRAY['new', 'paid', 'shipped', 'done'])[1 + g % 4],
  now() - (g || ' minutes')::interval,
  CASE WHEN g % 10 = 0 THEN E'multi\nline note' END,
  CASE WHEN g % 50 = 0 THEN '\xdeadbeef'::bytea END
FROM generate_series(1, 1000000) g;

CREATE VIEW sales.big_orders AS SELECT * FROM sales.orders WHERE amount > 300;
CREATE MATERIALIZED VIEW sales.revenue_by_status AS
  SELECT status, sum(amount) AS total, count(*) AS n FROM sales.orders GROUP BY status;

-- identifiers that need quoting
CREATE TABLE "Weird ""Name"" Table" ("Col A" int, "select" text);
INSERT INTO "Weird ""Name"" Table" VALUES (1, 'reserved word column');

-- generated and identity columns
CREATE TABLE sales.invoices (
  id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  net numeric(10, 2) NOT NULL,
  vat numeric(10, 2) GENERATED ALWAYS AS (net * 0.2) STORED
);
INSERT INTO sales.invoices (net) SELECT g FROM generate_series(1, 10) g;

-- a partitioned table (its partitions stay out of the sidebar)
CREATE TABLE sales.events (id bigint, at date NOT NULL, kind text) PARTITION BY RANGE (at);
CREATE TABLE sales.events_2025 PARTITION OF sales.events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE sales.events_2026 PARTITION OF sales.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
INSERT INTO sales.events SELECT g, date '2025-01-01' + g % 700, 'click' FROM generate_series(1, 5000) g;

ANALYZE;

-- a role that must log in with a password (see pg_hba in test-db.sh)
CREATE ROLE otter LOGIN PASSWORD 'otter-pass';
GRANT USAGE ON SCHEMA sales TO otter;
GRANT SELECT ON ALL TABLES IN SCHEMA public, sales TO otter;

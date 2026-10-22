-- Idempotent: run on every start. Money is always integer paise.

CREATE TABLE IF NOT EXISTS products (
  id          serial  PRIMARY KEY,
  name        text    NOT NULL,
  price_paise integer NOT NULL CHECK (price_paise > 0),
  stock       integer NOT NULL CHECK (stock >= 0) -- units physically in the counter
);

-- pending      : stock is held until expires_at
-- paid         : stock stays held until the locker hands it over
-- picked_up    : handed over; stock was reduced permanently
-- expired      : hold ran out without payment; holds nothing
-- needs_review : payment could not be accepted automatically; holds nothing
CREATE TABLE IF NOT EXISTS orders (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  status       text        NOT NULL CHECK (status IN ('pending', 'paid', 'picked_up', 'expired', 'needs_review')),
  total_paise  integer     NOT NULL CHECK (total_paise > 0),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz,
  picked_up_at timestamptz,
  review_reason text
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id         uuid    NOT NULL REFERENCES orders (id),
  product_id       integer NOT NULL REFERENCES products (id),
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_price_paise integer NOT NULL CHECK (unit_price_paise > 0),
  PRIMARY KEY (order_id, product_id)
);
CREATE INDEX IF NOT EXISTS order_items_by_product ON order_items (product_id);

-- One row per provider event id: the primary key is what makes a repeated event a no-op.
-- order_id is plain text (no foreign key) so events for unknown orders are still recorded.
CREATE TABLE IF NOT EXISTS payment_events (
  event_id     text        PRIMARY KEY,
  order_id     text        NOT NULL,
  amount_paise bigint      NOT NULL,
  status       text        NOT NULL,
  outcome      text,
  received_at  timestamptz NOT NULL DEFAULT now()
);

BEGIN;

ALTER TABLE public.byteburger_orders
  ADD COLUMN IF NOT EXISTS idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS tracking_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS byteburger_orders_idempotency_key_idx
  ON public.byteburger_orders (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS byteburger_orders_tracking_code_idx
  ON public.byteburger_orders (tracking_code)
  WHERE tracking_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS byteburger_orders_status_created_at_idx
  ON public.byteburger_orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS burgerbyte_category_idx
  ON public."BurgerByte" (category);
CREATE INDEX IF NOT EXISTS byteburger_order_items_order_id_idx
  ON public.byteburger_order_items (order_id);

CREATE TABLE IF NOT EXISTS public.byteburger_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.byteburger_order_json(p_order_id BIGINT)
RETURNS JSONB
LANGUAGE SQL
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'id', o.id::TEXT,
    'customer_name', o.customer_name,
    'phone', o.phone,
    'address', o.address,
    'subtotal', o.subtotal,
    'delivery_fee', o.delivery_fee,
    'total', o.total,
    'status', o.status,
    'created_at', o.created_at,
    'tracking_code', o.tracking_code,
    'items', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', oi.menu_item_id,
          'name', oi.item_name,
          'price', oi.unit_price,
          'quantity', oi.quantity,
          'subtotal', oi.line_total
        )
        ORDER BY oi.id
      )
      FROM public.byteburger_order_items AS oi
      WHERE oi.order_id = o.id
    ), '[]'::JSONB)
  )
  FROM public.byteburger_orders AS o
  WHERE o.id = p_order_id;
$$;

CREATE OR REPLACE FUNCTION public.create_byteburger_order(
  p_customer_name TEXT,
  p_phone TEXT,
  p_address TEXT,
  p_items JSONB,
  p_idempotency_key UUID,
  p_tracking_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  requested_item JSONB;
  menu_item RECORD;
  calculated_items JSONB := '[]'::JSONB;
  new_order public.byteburger_orders%ROWTYPE;
  order_subtotal BIGINT := 0;
  order_delivery_fee INTEGER;
  requested_id BIGINT;
  requested_quantity INTEGER;
BEGIN
  IF p_idempotency_key IS NULL OR NULLIF(BTRIM(p_tracking_code), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'A valid idempotency key is required.';
  END IF;

  SELECT * INTO new_order
    FROM public.byteburger_orders
    WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN public.byteburger_order_json(new_order.id);
  END IF;

  IF NULLIF(BTRIM(p_customer_name), '') IS NULL
     OR NULLIF(BTRIM(p_phone), '') IS NULL
     OR NULLIF(BTRIM(p_address), '') IS NULL
     OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Customer details and at least one menu item are required.';
  END IF;
  IF jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Add between 1 and 50 different menu items.';
  END IF;

  FOR requested_item IN SELECT value FROM jsonb_array_elements(p_items) AS entries(value)
  LOOP
    BEGIN
      requested_id := (requested_item ->> 'id')::BIGINT;
      requested_quantity := (requested_item ->> 'quantity')::INTEGER;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Each item needs a valid menu ID and quantity.';
    END;

    IF requested_id < 1 OR requested_quantity < 1 OR requested_quantity > 50 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Each item needs a valid menu ID and a quantity between 1 and 50.';
    END IF;

    IF calculated_items @> jsonb_build_array(jsonb_build_object('id', requested_id)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Each menu item may only appear once in the items list.';
    END IF;

    SELECT id, name, category, price, is_available
      INTO menu_item
      FROM public."BurgerByte"
      WHERE id = requested_id
      FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = FORMAT('Menu item %s no longer exists.', requested_id);
    END IF;
    IF menu_item.is_available IS NOT TRUE THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = FORMAT('%s is sold out.', menu_item.name);
    END IF;

    order_subtotal := order_subtotal + (menu_item.price::BIGINT * requested_quantity);
    calculated_items := calculated_items || jsonb_build_array(jsonb_build_object(
      'id', menu_item.id,
      'name', menu_item.name,
      'price', menu_item.price,
      'quantity', requested_quantity,
      'subtotal', menu_item.price::BIGINT * requested_quantity
    ));
  END LOOP;

  order_delivery_fee := CASE WHEN order_subtotal >= 2500 THEN 0 ELSE 200 END;

  BEGIN
    INSERT INTO public.byteburger_orders (
      customer_name, phone, address, subtotal, delivery_fee, total, idempotency_key, tracking_code
    )
    VALUES (
      BTRIM(p_customer_name), BTRIM(p_phone), BTRIM(p_address),
      order_subtotal, order_delivery_fee, order_subtotal + order_delivery_fee,
      p_idempotency_key, p_tracking_code
    )
    RETURNING * INTO new_order;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO new_order
      FROM public.byteburger_orders
      WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN public.byteburger_order_json(new_order.id);
    END IF;
    RAISE;
  END;

  INSERT INTO public.byteburger_order_items (
    order_id, menu_item_id, item_name, unit_price, quantity, line_total
  )
  SELECT
    new_order.id,
    (item.value ->> 'id')::BIGINT,
    item.value ->> 'name',
    (item.value ->> 'price')::INTEGER,
    (item.value ->> 'quantity')::INTEGER,
    (item.value ->> 'subtotal')::BIGINT
  FROM jsonb_array_elements(calculated_items) AS item(value);

  RETURN public.byteburger_order_json(new_order.id);
END;
$$;

REVOKE ALL ON FUNCTION public.create_byteburger_order(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_byteburger_order(TEXT, TEXT, TEXT, JSONB, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.byteburger_order_json(BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_byteburger_order(TEXT, TEXT, TEXT, JSONB, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.byteburger_order_json(BIGINT) TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'byteburger_orders'
  ) IS FALSE THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.byteburger_orders;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'BurgerByte'
  ) IS FALSE THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public."BurgerByte";
  END IF;
END
$$;

INSERT INTO public.byteburger_schema_migrations(version)
VALUES ('002_sessions_realtime_idempotency')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;

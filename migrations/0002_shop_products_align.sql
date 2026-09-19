-- Migration 0002: dua bang `products` production ve dung schema code.
-- Production dang la schema store_* (id, store_id NOT NULL FK stores, name,
-- description, price, currency, stock, image_url, status, created_at, updated_at)
-- trong khi backend CRUD theo schema code (id, name, description, price,
-- image_url, category, active, created_at, seller_email).
-- Da verify: products = 0 dong, orders = 0 dong, stores = 1 dong
-- (2026-09-18) nen rebuild an toan; van giu map du lieu phong khi co dong moi.
PRAGMA foreign_keys=OFF;

CREATE TABLE IF NOT EXISTS products_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price INTEGER DEFAULT 0,
  image_url TEXT DEFAULT '',
  category TEXT DEFAULT 'general',
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  seller_email TEXT NOT NULL
);

INSERT OR IGNORE INTO products_new
  (id, name, description, price, image_url, category, active, created_at, seller_email)
SELECT
  id,
  name,
  COALESCE(description, ''),
  COALESCE(price, 0),
  COALESCE(image_url, ''),
  'general',
  CASE WHEN status = 'active' THEN 1 ELSE 0 END,
  COALESCE(created_at, 0),
  ''
FROM products;

DROP TABLE IF EXISTS products;
ALTER TABLE products_new RENAME TO products;

PRAGMA foreign_keys=ON;

-- Kiem chung sau migrate (chay tay): SELECT COUNT(*) FROM products;

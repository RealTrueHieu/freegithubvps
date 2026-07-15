CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  username TEXT,
  avatar_key TEXT,
  session_version INTEGER NOT NULL DEFAULT 0,
  profile_updated_at INTEGER,
  github_token TEXT,
  ngrok_token TEXT,
  owner TEXT,
  credits INTEGER DEFAULT 0,
  token_status TEXT DEFAULT 'active',
  token_dead_reason TEXT,
  token_dead_at TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  ngrok_url TEXT,
  username TEXT,
  password TEXT,
  owner TEXT,
  repo TEXT DEFAULT 'vps',
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS products (
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

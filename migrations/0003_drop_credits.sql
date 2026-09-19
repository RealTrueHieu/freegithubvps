-- Migration 0003: go che do Credits (theo yeu cau chu shop 2026-09-18).
-- Backend/frontend da go sach moi reference; cot nay khong con code nao doc/ghi.
-- SQLite/D1 ho tro DROP COLUMN truc tiep (D1 runtime hien tai OK).
ALTER TABLE users DROP COLUMN credits;

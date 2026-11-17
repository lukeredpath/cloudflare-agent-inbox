-- Lanes can accept mail forwarded by a trusted forwarder, judged by the
-- original sender's authentication recorded in the forwarder's ARC set.
-- JSON array of { from, require }; NULL = none.
ALTER TABLE lanes ADD COLUMN forwarded_from TEXT;

-- A size-capped excerpt of authentication headers, kept only for failures where
-- the envelope sender was allowed (a likely genuine forward). No bodies.
ALTER TABLE rejections ADD COLUMN diagnostics TEXT;

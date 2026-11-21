-- Lanes can refuse mail from particular senders, whatever else it passes.
-- JSON array of addresses or *@domain patterns; NULL = none.
ALTER TABLE lanes ADD COLUMN blocked_senders TEXT;

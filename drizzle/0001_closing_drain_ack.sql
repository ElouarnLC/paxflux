-- A device session records the closing epoch it has explicitly acknowledged
-- as fully drained. `NULL` means "not acknowledged for the current epoch".
--
-- Bound to the epoch (`events.closing_started_at_ms`) rather than to a
-- timestamp comparison, because a report prepared before the transition can
-- arrive after it and would otherwise be read as confirming an epoch it
-- knew nothing about.
ALTER TABLE `device_sessions` ADD `drained_for_closing_at_ms` integer;

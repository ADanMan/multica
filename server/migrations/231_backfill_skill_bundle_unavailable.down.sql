-- Reverse the backfill: return the re-classified rows to the catchall bucket
-- they came from. The error / content text used as the witness is preserved on
-- the row, so the same WHERE clause selects the same set unless someone
-- relabelled by hand in between.
UPDATE agent_task_queue
SET failure_reason = 'agent_error.unknown'
WHERE status = 'failed'
  AND failure_reason = 'skill_bundle_unavailable'
  AND error LIKE 'resolve skill bundles:%';

UPDATE chat_message
SET failure_reason = 'agent_error.unknown'
WHERE failure_reason = 'skill_bundle_unavailable'
  AND content LIKE 'resolve skill bundles:%';

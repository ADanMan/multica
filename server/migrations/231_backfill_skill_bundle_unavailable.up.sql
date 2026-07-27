-- Backfill the skill_bundle_unavailable reason introduced in MUL-5370.
--
-- The daemon now labels "could not download the agent's skill bundles"
-- structurally instead of letting the wrapped transport error fall through
-- taskfailure.Classify into agent_error.unknown. That change is forward-only:
-- historical rows still sit in the unknown bucket, which makes the failure
-- invisible on the failure_reason board — exactly the observability gap that
-- let this bug survive in the wild.
--
-- The witness is the old wrapper prefix these rows were written with
-- ("resolve skill bundles: ..."), which is stable and unambiguous: no other
-- code path produced it. Scoped to the two buckets that path could land in
-- (agent_error.unknown, plus the legacy coarse agent_error for rows that
-- predate MUL-2946's in-flight classifier).
UPDATE agent_task_queue
SET failure_reason = 'skill_bundle_unavailable'
WHERE status = 'failed'
  AND COALESCE(failure_reason, '') IN ('agent_error.unknown', 'agent_error')
  AND error LIKE 'resolve skill bundles:%';

-- chat_message mirrors the task's failure_reason for chat turns, and the chat
-- bubble reads it directly — leaving these behind would keep showing the
-- generic "something went wrong" copy on historical turns.
UPDATE chat_message
SET failure_reason = 'skill_bundle_unavailable'
WHERE COALESCE(failure_reason, '') IN ('agent_error.unknown', 'agent_error')
  AND content LIKE 'resolve skill bundles:%';

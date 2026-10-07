---
'@zooid/transport-matrix': patch
---

A closed task's thread no longer caps `zooid_start_task_threads`

Since #38 a delegated task's completion wakes its caller in the task's own
thread. That thread root stays registered after the task closes (kept for trust
checks), so `taskForRoot` still returned the record — now `phase: 'closed'` — and
`describeRole` reported `can_start_task_threads: false` while `startTasks`
refused with `depth_limit`. An agent woken in a closed task thread therefore
lost `zooid_start_task_threads` even though the thread is ordinary conversation
again.

`describeRole` and `startTasks` now read the enclosing task through the new
`TaskRegistry.enclosingTaskForRoot`, which returns the record only while its task
is open — matching `openTaskFor`, `handoff` and the turn boundary. The open-task
path is unchanged.

---
'zooid': patch
---

Recover from a wedged resumed session instead of silently swallowing prompts.

A session resumed across a daemon restart could accept a prompt (the ACP stream
carries the `user_message_chunk`) and then never answer — no chunk, no tool
call, no error, container at 0% CPU — so the agent looked alive to `docker ps`
but was deaf. Dispatch now has a **first-response deadline**: if a prompt
produces nothing at all within it (default 5m, per-agent override
`agents.<name>.first_response_timeout`), the session is declared wedged,
invalidated in memory and in `sessions.json`, and the client is marked dead so
the registry reconnects with a fresh container. The prompt is then **replayed
on the fresh session**, bounded to one replay (`maxPromptAttempts`) so a
persistently wedged agent can never loop. Transports re-key their per-session
state across the swap and post a visible `dev.zooid.error` /
`[session_wedge]` notice in the thread saying whether the message was replayed
— the owner's only signal used to be absence.
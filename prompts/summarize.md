CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use any tools in this turn.
- Tool calls will be rejected and waste the compaction turn.
- Output must be plain text with exactly two blocks: <analysis> ... </analysis> and <summary> ... </summary>.

You are mid-task inside an agent loop.

Compress the history below into a concise context block while preserving:
- Facts relevant to: "{{user_message}}"
- Skills already called, including failures and blocked/denied actions
- Partial information still useful in later rounds
- Important file paths, URLs, tool outputs, and intermediate conclusions

History:
{{history}}

In <summary>, produce a compact continuation-ready handoff with:
1. Current objective
2. Verified facts and evidence
3. Tool outcomes (successes, failures, permission denials)
4. Pending next steps

REMINDER: Do NOT call tools. Return plain text only.

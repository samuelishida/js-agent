# PRODUCT.md

register: product
layout: three-panel (nav-sidebar + chat-canvas + activity-log)

---

## Users

**Architect**
Developer testing or building agent pipelines. Switched here from an editor to verify a tool chain terminates correctly. Needs full tool I/O visibility — every tool call, its args, its return value, the model's reasoning step. Will abort mid-run if tool input looks wrong.

**Operator**
Launched a long multi-step task and stepped away. Returns to check progress. Primary questions: is it still running, how many rounds remain, did it get stuck, can I interrupt cleanly. Needs progress state visible without opening any panel.

**Explorer**
Experimenting with model and tool combinations on a weekend afternoon. Swapping Mistral for Llama, comparing outputs across sessions. Needs quick history access, clear per-step output, easy session comparison without context-switching.

**Browser Integrator**
Running browser tool chains in split-screen — live webpage on left, agent canvas on right. Executing navigate, click, extract, screenshot sequences. Needs URL trace, DOM action log, and screenshot preview surfaced in the activity panel without leaving the session.

---

## Brand Pillars

1. **Precise** — every token visible, no hidden state, no ambiguous status
2. **Operational** — tools are first-class citizens; this is a work surface, not a chat app
3. **Legible** — dense but readable; hierarchy through weight and spacing, not decoration

---

## Restrictions

- No emojis as UI elements
- No chat bubble layout (tool calls render as structured log lines, not message cards)
- No motion that does not communicate a state change
- No color-only status encoding (pair color with label or icon)
- No generic AI assistant iconography
- No light mode as default
- No rounded-corner decoration for its own sake
- No placeholder suggested prompts that obscure the tool surface

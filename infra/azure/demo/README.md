# Demo video: Foundry agents, one memory, governed

`record-portal.sh` records the demo in the real portals: the Microsoft Foundry playground, then OpenMetadata. It
drives the *portal browser* on the VM (`../vm/portal-browser`, a Chromium you sign in to over noVNC) and writes
`docs/demo/wisteria-portal-demo.mp4`, with the agents' thinking time sped up 8x.

```bash
./infra/azure/push.sh "bash infra/azure/vm/portal-up.sh"   # then sign in, over noVNC: ai.azure.com + OpenMetadata
./infra/azure/demo/record-portal.sh                       # reset the team memory, record, edit (~12 minutes)
./infra/azure/push.sh "bash infra/azure/vm/portal-down.sh" # stop the browser, delete the signed-in profile
```

Options: `--keep` keeps the current team memory; `SCENES=foundry` or `SCENES=om` records one part; `DRY=1` runs the
steps without recording (a rehearsal); `SPEEDUP=1` keeps the waits at normal speed. On a failure the recorder saves
`docs/demo/failed-foundry.png` and `failed-om.png`.

How it works: `portal-record.mjs` runs inside the portal-browser container and attaches to the signed-in Chromium
over CDP. ffmpeg grabs the X display (browser chrome included, so the address bar shows the real portal), xdotool
moves the real pointer and clicks, and captions are drawn into the page. It types prompts but never a password, and
it selects `gpt-5.4` in the playground before each chat (the picker can switch to another deployment in the account).
It waits for each answer (the playground's Stop button turns back into Send) and records those stretches in
`portal-segments.json` for `speedup.py`.

## Storyline

1. **Title card**.
2. **Foundry, project `wisteria-agents`**: the four agents. Open the Support Lead: the playground shows its model and
   its two MCP tools, `wisteria-brain-*` (company brain + team memory) and `wisteria-om-*` (OpenMetadata, read-only).
3. **Support Lead**: "Novaris Holdings keeps escalating…" It reads tickets, cases and Jira, answers with cited records
   and saves its findings (`[[memory:…]]`): agent-memory on Atlas, mirrored to OpenMetadata by its own bot.
4. **Account Manager**: "Why did Novaris Holdings churn? Start from what the team already knows… propose a name if
   the glossary lacks one." It recalls the Support Lead's memories first and proposes a new concept.
5. **RevOps Analyst**: what Finance should report, with the governed ARR definition read from OpenMetadata.
6. **Product Lead**: what to fix first (team memory) and which personal-data datasets that touches, with owners
   (OpenMetadata).
7. **OpenMetadata**: Context Center memories (authors = the agents' bots), one memory's linked assets, lineage
   agents → `agent_memory.memories` → Company Brain agent, the proposed glossary term (In Review, owner = the agent's
   team, reviewer = Data Platform) and the glossary's relations graph.
8. **End card**.

Edit the prompts and captions in `CHATS` at the top of `portal-record.mjs`.

## Exploring the portals

`portal-act.mjs` runs a list of steps against the portal browser (click, type, screenshot, dump the visible controls,
evaluate a JavaScript expression), for finding selectors before scripting a scene; `portal-peek.mjs` screenshots
every tab. Both run inside the container: `docker exec -e ACTIONS='[…]' brain_portal_browser sh -c 'cp
/demo/portal-act.mjs /app/ && cd /app && node portal-act.mjs'`; screenshots land in `/opt/brain/data/demo` on the VM.

## The older `/team` recording

`record.sh` drives the stack's own `/team` page with a headless Playwright inside the compose network and writes
`docs/demo/wisteria-agents-demo.mp4` (`record-demo.mjs`, prompts in `apps/web/src/TeamApp.tsx`).

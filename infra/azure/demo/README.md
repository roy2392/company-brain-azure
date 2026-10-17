# Demo video: Foundry agents, one memory, governed

`record-portal.sh` records the demo in the real portals: the Microsoft Foundry playground, then OpenMetadata. It
drives the *portal browser* on the VM (`../vm/portal-browser`, a Chromium you sign in to over noVNC) and writes
`docs/demo/wisteria-portal-walkthrough.mp4`, with the agents' thinking time sped up 8x.

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
7. **OpenMetadata 2.0, the catalog** (`catalogTour`): the six Era by Eon services next to MongoDB Atlas, Slack
   `messages` (owner, domain, concept, foreign keys), Zendesk `users` with PII tags per column, column-level lineage
   from Zendesk `tickets` to Atlas (full screen, one column highlighted), the Knowledge Graph, the Escalation Rate
   metric's MongoDB code and the Data Marketplace's Customer 360 Brain data product. Each step is skipped, not
   fatal, if the UI changes; `TOUR=lineage,metric` runs only some steps, `TOUR_ONLY=1` stops after the tour, and
   `SKIP_TOUR=1` leaves it out.
8. **OpenMetadata, the memory**: Context Center memories (authors = the agents' bots), one memory's linked assets,
   lineage agents → `agent_memory.memories` → Company Brain agent, the proposed glossary term (In Review, owner = the
   agent's team, reviewer = Data Platform) and the Ontology Explorer (the glossary's relations graph as a fallback).
9. **End card**.

Edit the prompts and captions in `CHATS` at the top of `portal-record.mjs`.

Captions and cards match the slide deck's "blueprint" look: pale panels with a solid offset edge in product colours
(Foundry blue, MongoDB green, OpenMetadata purple), Barlow Condensed and Inter, a rise-and-fade entrance, and cards
laid out like a slide with the real logos. The fonts (SIL Open Font License, see `assets/fonts/OFL-*.txt`) load from
`assets/fonts` through the FontFace API and the logos from `assets/logos` as inline SVG, so the portals' CSP and
Trusted Types don't get in the way. Style lives in `DECK_CSS` in `portal-record.mjs`.

## The trailer

`docs/demo/wisteria-portal-demo.mp4` is a 3½-minute trailer cut from the walkthrough and timed to a music track. The
story: a Microsoft × MongoDB opener, the dark Knowledge Graph with "every company already has a brain", the brain scattered across six systems, "what
if it could remember, reason and prove every answer?", the four personas (a panel over each agent's chat at ~12x), one
beat per capability, the stack slammed in on four hits, a rapid-fire montage, the title drop, back to the graph, black,
and the date on the final boom. Cards are animated in the deck's style (`cards.html`); overlay cards render with a
transparent background and are composited over the footage.

```bash
cd infra/azure/demo/trailer && bun install
bun render.mjs /tmp/cards                      # renders the cards (cards.html) frame by frame in headless Chrome
python3 assemble.py ../../../../docs/demo/wisteria-portal-walkthrough.mp4 <music.mp3> /tmp/cards ../../../../docs/demo/wisteria-portal-demo.mp4
```

`TIMELINE` in `assemble.py` holds the cut list: each card or footage window (start and end in the walkthrough) and
its start time in the music. The windows belong to one take, so after a re-record, re-time them from a contact sheet of the
new walkthrough (`ffmpeg -i walkthrough.mp4 -vf "fps=1/2,scale=240:-1,tile=10x11" sheet.png`). The music isn't in
the repo; the trailer uses "Heroic Motif" (made with Suno; 207.96 s: a quiet intro to 60.4 s, drums at ~134 bpm from 60.4 to
84.1 s and 91.4 to 118.2 s, a calm stretch with hits at 127.75 to 152.65 s, the climax 156.1 to 179.4 s, a build from
183.2 s, the last peak at 196.65 s, a fade from 203 s). Entries in `TIMELINE` start at absolute music times, and the
drum sections cut on bar lines (`BAR`).

## Exploring the portals

`portal-act.mjs` runs a list of steps against the portal browser (click, type, screenshot, dump the visible controls,
evaluate a JavaScript expression), for finding selectors before scripting a scene; `portal-peek.mjs` screenshots
every tab. Both run inside the container: `docker exec -e ACTIONS='[…]' brain_portal_browser sh -c 'cp
/demo/portal-act.mjs /app/ && cd /app && node portal-act.mjs'`; screenshots land in `/opt/brain/data/demo` on the VM.

## The older `/team` recording

`record.sh` drives the stack's own `/team` page with a headless Playwright inside the compose network and writes
`docs/demo/wisteria-agents-demo.mp4` (`record-demo.mjs`, prompts in `apps/web/src/TeamApp.tsx`).

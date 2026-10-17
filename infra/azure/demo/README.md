# Demo video: four agents, one memory, governed

`record.sh` resets the team memory, drives `/team` with Playwright on the VM (inside the compose network, so no
password is typed), and writes `docs/demo/wisteria-agents-demo.mp4` with the agents' thinking time sped up 8x.

## Storyline

1. **Title**: Wisteria's role agents run in Microsoft Foundry, share one memory (agent-memory on MongoDB Atlas),
   governed in OpenMetadata.
2. **Support Lead** investigates Novaris Holdings' escalations from scratch, answers with cited records and saves its
   findings: they appear in *Shared memory* (Atlas) and get the "in OpenMetadata ✓" badge.
3. **Account Manager** asks why Novaris churned: its first tool call recalls the Support Lead's memories, so it only
   investigates the gaps (calls, deals, Slack) and saves the churn reason.
4. **RevOps** recalls both teammates' memories and reads the governed ARR definition from OpenMetadata to say what
   Finance should report.
5. **Product Lead** turns the team's findings into product priorities.
6. **In OpenMetadata**: the same memories in the Context Center, authored by each agent's bot, owned by its team,
   linked to `agent_memory.memories`; lineage agents → memories → Company Brain agent.
7. **Company context**: RevOps asks the catalog who owns ARR and which datasets feed it; Product Lead asks which
   personal-data datasets feed the agents. Both answered from OpenMetadata over MCP.
8. **End card**.

Edit the prompts in `apps/web/src/TeamApp.tsx` (`PROMPTS`) and the scenes in `record-demo.mjs`.

/**
 * Forget the agent team's memory before a fresh demo: agent-memory documents in Atlas, their OpenMetadata mirror
 * and the glossary terms the agents proposed from it.
 *   npm run team:reset
 */
import { teamMemory } from "../src/agents/memory.ts";
import { closeDb } from "../src/brain/store.ts";
import { forgetDerivedTerms, forgetPromotedMemories } from "../src/om/agents.ts";
import { OM } from "../src/om/client.ts";

const docs = await teamMemory.reset();
const om = await new OM().login();
const mirrored = await forgetPromotedMemories(om);
const terms = await forgetDerivedTerms(om);
console.log(`team memory reset: ${docs} agent-memory documents, ${mirrored} OpenMetadata Context Center memories, ${terms} proposed glossary terms`);
await closeDb();

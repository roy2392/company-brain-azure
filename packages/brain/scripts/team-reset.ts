/**
 * Forget the agent team's memory before a fresh demo: agent-memory documents in Atlas and their OpenMetadata mirror.
 *   npm run team:reset
 */
import { teamMemory } from "../src/agents/memory.ts";
import { closeDb } from "../src/brain/store.ts";
import { forgetPromotedMemories } from "../src/om/agents.ts";
import { OM } from "../src/om/client.ts";

const docs = await teamMemory.reset();
const mirrored = await forgetPromotedMemories(await new OM().login());
console.log(`team memory reset: ${docs} agent-memory documents, ${mirrored} OpenMetadata Context Center memories`);
await closeDb();

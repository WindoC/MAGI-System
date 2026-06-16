import { z } from "zod";

export const agentOutputSchema = z.object({
  agent: z.enum(["melchior", "balthasar", "casper"]),
  decision: z.enum(["yes", "no", "error"]),
  confidence: z.number().min(0).max(1),
  shared_explanation: z.string().trim().min(1),
  objections_to_others: z.record(z.string(), z.string()).default({}),
  persuasion_message: z.string().default(""),
  what_would_change_my_mind: z.string().default(""),
  tool_requests: z.array(
    z.object({
      tool: z.literal("internet_search"),
      query: z.string().trim().min(1)
    })
  ).default([])
});

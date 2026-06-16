import type { AgentDefinition } from "./types";

export const AGENTS: AgentDefinition[] = [
  {
    name: "melchior",
    displayName: "Melchior",
    role: "Scientific and rational evaluator",
    focus: ["Facts", "Evidence", "Logic", "Consistency"],
    priority: ["Correctness", "Evidence quality", "Logical consistency"],
    model: process.env.MAGI_MELCHIOR_MODEL ?? "nvidia/nemotron-3-super-120b-a12b:free"
  },
  {
    name: "balthasar",
    displayName: "Balthasar",
    role: "Human-centric evaluator",
    focus: ["Human impact", "Safety", "Risk", "Social consequences"],
    priority: ["Human impact", "Safety", "Risk reduction"],
    model: process.env.MAGI_BALTHASAR_MODEL ?? "google/gemma-4-31b-it:free"
  },
  {
    name: "casper",
    displayName: "Casper",
    role: "Adversarial evaluator",
    focus: ["Failure scenarios", "Unknown risks", "Edge cases", "Alternative interpretations"],
    priority: ["Failure prevention", "Survivability", "Alternative strategies"],
    model: process.env.MAGI_CASPER_MODEL ?? "openai/gpt-oss-120b:free"
  }
];

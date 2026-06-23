import { NextResponse } from "next/server";
import { AGENTS } from "../../../src/magi/agents";
import type { AgentName } from "../../../src/magi/types";

export const dynamic = "force-dynamic";

type PublicAgentConfig = {
  name: AgentName;
  displayName: string;
  role: string;
  model: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  reasoning: boolean;
  maxToolIterations: number;
};

export function GET() {
  const configs: PublicAgentConfig[] = AGENTS.map((agent) => ({
    name: agent.name,
    displayName: agent.displayName,
    role: agent.role,
    model: agent.model,
    temperature: Number(process.env[`MAGI_${agent.name.toUpperCase()}_TEMPERATURE`] ?? defaultTemperature(agent.name)),
    topP: Number(process.env[`MAGI_${agent.name.toUpperCase()}_TOP_P`] ?? defaultTopP(agent.name)),
    maxTokens: Number(process.env.MAGI_NUM_PREDICT ?? 1800),
    reasoning: envBool("OPENROUTER_REASONING", true),
    maxToolIterations: Math.max(0, Number(process.env.MAGI_MAX_TOOL_ITERATIONS ?? 2))
  }));

  return NextResponse.json({ agents: configs });
}

function defaultTemperature(agentName: AgentName): number {
  if (agentName === "melchior") {
    return 0.15;
  }
  if (agentName === "balthasar") {
    return 0.35;
  }
  return 0.7;
}

function defaultTopP(agentName: AgentName): number {
  if (agentName === "melchior") {
    return 0.85;
  }
  if (agentName === "balthasar") {
    return 0.9;
  }
  return 0.95;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

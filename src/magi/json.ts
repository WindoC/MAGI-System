import { jsonrepair } from "jsonrepair";

export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Model response did not contain a JSON object.");
  }

  const objectText = candidate.slice(start, end + 1);
  try {
    return JSON.parse(objectText);
  } catch {
    return JSON.parse(jsonrepair(objectText));
  }
}

export function splitRawThinking(text: string): { rawThinking: string; visibleText: string } {
  const thinkBlocks = [...text.matchAll(/<think>([\s\S]*?)<\/think>/gi)];
  if (thinkBlocks.length === 0) {
    return { rawThinking: "", visibleText: text };
  }

  const rawThinking = thinkBlocks.map((match) => match[1].trim()).join("\n\n");
  const visibleText = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return { rawThinking, visibleText };
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
  }
  return value;
}

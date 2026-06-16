"""
MAGI System MVP demo - round-based multi-agent deliberation with OpenRouter models.

This is a Python-only LangGraph demo of the PRD logic in prd.md.
It is read-only: the only tool is an OpenRouter-backed internet_search adapter.
"""

import json
import operator
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime
from typing import Annotated, Literal, TypedDict

from dotenv import load_dotenv
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph

load_dotenv()

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def _debug(message: str, **details) -> None:
    if not MAGI_DEBUG:
        return

    timestamp = datetime.now().strftime("%H:%M:%S")
    if details:
        detail_text = " ".join(f"{key}={value}" for key, value in details.items())
        print(f"[{timestamp}] {message} | {detail_text}", flush=True)
        return

    print(f"[{timestamp}] {message}", flush=True)


AgentName = Literal["melchior", "balthasar", "casper"]
Decision = Literal["yes", "no"]


def _env_bool(name: str, default: bool = True) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


MAGI_DEBUG = _env_bool("MAGI_DEBUG", True)
MAGI_NUM_PREDICT = int(os.getenv("MAGI_NUM_PREDICT", "1800"))
MAGI_REPAIR_NUM_PREDICT = int(os.getenv("MAGI_REPAIR_NUM_PREDICT", "1200"))
MAGI_MAX_TOOL_ITERATIONS = int(os.getenv("MAGI_MAX_TOOL_ITERATIONS", "2"))
MAGI_MAX_ROUNDS = int(os.getenv("MAGI_MAX_ROUNDS", "3"))
MAGI_ENABLE_INTERNET_SEARCH = _env_bool("MAGI_ENABLE_INTERNET_SEARCH", False)
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
OPENROUTER_REASONING = _env_bool("OPENROUTER_REASONING", True)
OPENROUTER_SEARCH_URL = os.getenv(
    "OPENROUTER_SEARCH_URL",
    "https://openrouter.ai/api/v1/chat/completions",
)
OPENROUTER_SEARCH_MODEL = os.getenv(
    "OPENROUTER_SEARCH_MODEL",
    "perplexity/sonar-pro-search",
)
OPENROUTER_SEARCH_MAX_RESULTS = int(os.getenv("OPENROUTER_SEARCH_MAX_RESULTS", "5"))
OPENROUTER_SEARCH_TIMEOUT = int(os.getenv("OPENROUTER_SEARCH_TIMEOUT", "120"))

AGENTS: dict[AgentName, dict[str, str | float]] = {
    "melchior": {
        "role": "Scientific and rational evaluator",
        "focus": "facts, evidence, logic, consistency",
        "priority": "correctness, evidence quality, logical consistency",
        "model": os.getenv("MAGI_MELCHIOR_MODEL", "qwen/qwen3.6-27b"),
        "temperature": float(os.getenv("MAGI_MELCHIOR_TEMPERATURE", "0.15")),
        "top_p": float(os.getenv("MAGI_MELCHIOR_TOP_P", "0.85")),
    },
    "balthasar": {
        "role": "Human-centric evaluator",
        "focus": "human impact, safety, risk, social consequences",
        "priority": "human impact, safety, risk reduction",
        "model": os.getenv("MAGI_BALTHASAR_MODEL", "google/gemma-4-31b-it:free"),
        "temperature": float(os.getenv("MAGI_BALTHASAR_TEMPERATURE", "0.35")),
        "top_p": float(os.getenv("MAGI_BALTHASAR_TOP_P", "0.9")),
    },
    "casper": {
        "role": "Adversarial evaluator",
        "focus": "failure scenarios, unknown risks, edge cases, alternatives",
        "priority": "failure prevention, survivability, alternative strategies",
        "model": os.getenv("MAGI_CASPER_MODEL", "openai/gpt-oss-20b:free"),
        "temperature": float(os.getenv("MAGI_CASPER_TEMPERATURE", "0.7")),
        "top_p": float(os.getenv("MAGI_CASPER_TOP_P", "0.95")),
    },
}


class AgentOutput(TypedDict):
    round: int
    agent: AgentName
    decision: Decision
    confidence: float
    shared_explanation: str
    objections_to_others: dict[str, str]
    persuasion_message: str
    what_would_change_my_mind: str
    tool_requests: list[dict]
    tool_results: list[dict]
    parse_error: bool


class ThinkingLog(TypedDict):
    round: int
    agent: AgentName
    iteration: int
    phase: str
    thinking: str | None


class MagiState(TypedDict):
    query: str
    current_round: int
    max_rounds: int
    search_before_discuss: list
    shared_search_pool: Annotated[list, operator.add]
    discussion_history: Annotated[list, operator.add]
    tool_history: Annotated[list, operator.add]
    user_audit_log: Annotated[list, operator.add]
    thinking_log: Annotated[list[ThinkingLog], operator.add]
    agent_outputs: Annotated[list[AgentOutput], operator.add]
    round_snapshot: dict
    final_decision: dict | None


def _extract_thinking_from_content(content: str) -> tuple[str | None, str]:
    match = re.search(r"<think>(.*?)</think>", content, flags=re.S)
    if not match:
        return None, content

    thinking = match.group(1).strip()
    answer = re.sub(r"<think>.*?</think>", "", content, flags=re.S).strip()
    return thinking, answer


def _reasoning_details_to_text(reasoning_details) -> str | None:
    if not reasoning_details:
        return None

    parts = []
    for detail in reasoning_details:
        if not isinstance(detail, dict):
            continue

        if detail.get("text"):
            parts.append(str(detail["text"]))
        elif detail.get("summary"):
            parts.append(str(detail["summary"]))
        elif detail.get("data"):
            parts.append("[encrypted reasoning returned by provider]")

    return "\n\n".join(parts).strip() or None


def _extract_thinking(response) -> tuple[str | None, str]:
    thinking = (
        response.additional_kwargs.get("reasoning_content")
        or response.additional_kwargs.get("reasoning")
        or response.additional_kwargs.get("thinking")
        or _reasoning_details_to_text(
            response.additional_kwargs.get("reasoning_details")
        )
    )

    if thinking:
        return thinking, response.content or ""

    return _extract_thinking_from_content(response.content or "")


def _openrouter_extra_body(reasoning_enabled: bool) -> dict:
    if not reasoning_enabled:
        return {}
    return {"reasoning": {"enabled": True}}


def _agent_llm(agent: AgentName, reasoning_enabled: bool = OPENROUTER_REASONING) -> ChatOpenAI:
    settings = AGENTS[agent]
    model = str(settings["model"])
    temperature = float(settings["temperature"])
    top_p = float(settings["top_p"])
    _debug(
        "Initializing agent LLM",
        agent=agent,
        model=model,
        temperature=temperature,
        top_p=top_p,
        reasoning=reasoning_enabled,
    )
    return ChatOpenAI(
        model=model,
        api_key=OPENROUTER_API_KEY,
        base_url=OPENROUTER_BASE_URL,
        max_completion_tokens=MAGI_NUM_PREDICT,
        temperature=temperature,
        top_p=top_p,
        extra_body=_openrouter_extra_body(reasoning_enabled),
    )

def _agent_formatter_llm(agent: AgentName) -> ChatOpenAI:
    settings = AGENTS[agent]
    model = str(settings["model"])
    _debug("Initializing formatter LLM", agent=agent, model=model)
    return ChatOpenAI(
        model=model,
        api_key=OPENROUTER_API_KEY,
        base_url=OPENROUTER_BASE_URL,
        max_completion_tokens=MAGI_REPAIR_NUM_PREDICT,
        temperature=0,
        top_p=0.1,
        model_kwargs={"response_format": {"type": "json_object"}},
        extra_body={"reasoning": {"enabled": False}},
    )


FORMATTER_LLMS = {agent: _agent_formatter_llm(agent) for agent in AGENTS}


@tool("internet_search")
def internet_search_tool(query: str) -> str:
    """Search the public internet for current information relevant to the discussion."""
    result = internet_search(query, requester="agent")
    return json.dumps(
        {
            "answer": result.get("answer", ""),
            "results": result.get("results", []),
            "error": result.get("error"),
        },
        ensure_ascii=False,
    )


def _openrouter_chat_completion(payload: dict) -> dict:
    request = urllib.request.Request(
        OPENROUTER_SEARCH_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    with urllib.request.urlopen(request, timeout=OPENROUTER_SEARCH_TIMEOUT) as response:
        return json.loads(response.read().decode("utf-8"))


def _openrouter_tool_schema() -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": "internet_search",
                "description": (
                    "Search the public internet for current information relevant "
                    "to the MAGI discussion."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "A read-only internet search query.",
                        }
                    },
                    "required": ["query"],
                    "additionalProperties": False,
                },
            },
        }
    ]


def _message_to_openrouter_dict(message) -> dict:
    if isinstance(message, SystemMessage):
        return {"role": "system", "content": message.content}

    if isinstance(message, HumanMessage):
        return {"role": "user", "content": message.content}

    if isinstance(message, ToolMessage):
        return {
            "role": "tool",
            "tool_call_id": message.tool_call_id,
            "name": message.name,
            "content": message.content,
        }

    if isinstance(message, AIMessage):
        payload = {
            "role": "assistant",
            "content": message.content or "",
        }
        if message.tool_calls:
            payload["tool_calls"] = [
                {
                    "id": tool_call.get("id"),
                    "type": "function",
                    "function": {
                        "name": tool_call.get("name"),
                        "arguments": json.dumps(
                            tool_call.get("args") or {},
                            ensure_ascii=False,
                        ),
                    },
                }
                for tool_call in message.tool_calls
            ]

        if message.additional_kwargs.get("reasoning"):
            payload["reasoning"] = message.additional_kwargs["reasoning"]
        if message.additional_kwargs.get("reasoning_details"):
            payload["reasoning_details"] = message.additional_kwargs[
                "reasoning_details"
            ]

        return payload

    role = getattr(message, "type", "user")
    if role == "ai":
        role = "assistant"
    return {"role": role, "content": getattr(message, "content", "")}


def _openrouter_tool_calls_to_langchain(raw_tool_calls: list) -> list[dict]:
    tool_calls = []
    for raw_call in raw_tool_calls:
        function = raw_call.get("function") or {}
        raw_args = function.get("arguments") or {}
        if isinstance(raw_args, str):
            try:
                args = json.loads(raw_args) if raw_args.strip() else {}
            except json.JSONDecodeError:
                args = {"query": raw_args}
        elif isinstance(raw_args, dict):
            args = raw_args
        else:
            args = {}

        tool_calls.append(
            {
                "name": function.get("name") or raw_call.get("name"),
                "args": args,
                "id": raw_call.get("id"),
            }
        )

    return tool_calls


def _openrouter_agent_chat(
    agent: AgentName,
    messages: list,
    reasoning_enabled: bool,
) -> AIMessage:
    settings = AGENTS[agent]
    payload = {
        "model": str(settings["model"]),
        "messages": [_message_to_openrouter_dict(message) for message in messages],
        "max_tokens": MAGI_NUM_PREDICT,
        "temperature": float(settings["temperature"]),
        "top_p": float(settings["top_p"]),
    }
    if MAGI_ENABLE_INTERNET_SEARCH:
        payload["tools"] = _openrouter_tool_schema()
        payload["tool_choice"] = "auto"
        payload["parallel_tool_calls"] = True

    if reasoning_enabled:
        payload["reasoning"] = {"enabled": True}
        payload["include_reasoning"] = True
    else:
        payload["reasoning"] = {"exclude": True}
        payload["include_reasoning"] = False

    response = _openrouter_chat_completion(payload)
    message = response["choices"][0]["message"]
    additional_kwargs = {
        "raw_openrouter_message": message,
        "raw_openrouter_usage": response.get("usage"),
    }
    for key in ("reasoning", "reasoning_details", "refusal"):
        if key in message:
            additional_kwargs[key] = message[key]

    return AIMessage(
        content=message.get("content") or "",
        additional_kwargs=additional_kwargs,
        tool_calls=_openrouter_tool_calls_to_langchain(
            message.get("tool_calls") or []
        ),
    )


def _extract_openrouter_citations(message: dict) -> list[dict]:
    results = []
    for annotation in message.get("annotations", []) or []:
        if annotation.get("type") != "url_citation":
            continue

        citation = annotation.get("url_citation", {}) or {}
        results.append(
            {
                "title": citation.get("title", ""),
                "url": citation.get("url", ""),
                "snippet": citation.get("content", ""),
            }
        )

    return results[:OPENROUTER_SEARCH_MAX_RESULTS]


def internet_search(query: str, requester: str = "system") -> dict:
    """Read-only OpenRouter-backed internet search adapter."""
    _debug("internet_search:start", requester=requester, query=query)
    if not MAGI_ENABLE_INTERNET_SEARCH:
        result = {
            "tool": "internet_search",
            "requesting_agent": requester,
            "query": query,
            "answer": "",
            "results": [],
            "model": None,
            "error": "internet_search is disabled by MAGI_ENABLE_INTERNET_SEARCH.",
            "disabled": True,
        }
        _debug(
            "internet_search:disabled",
            requester=requester,
            result_count=0,
            error=True,
        )
        return result

    if not OPENROUTER_API_KEY:
        result = {
            "tool": "internet_search",
            "requesting_agent": requester,
            "query": query,
            "answer": "",
            "results": [],
            "error": "OPENROUTER_API_KEY is not set.",
        }
        _debug("internet_search:end", requester=requester, result_count=0, error=True)
        return result

    payload = {
        "model": OPENROUTER_SEARCH_MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a read-only internet search assistant. Search the web, "
                    "summarize only information relevant to the query, and cite sources."
                ),
            },
            {"role": "user", "content": query},
        ],
        "reasoning": {"enabled": True},
        "plugins": [
            {
                "id": "web",
                "max_results": OPENROUTER_SEARCH_MAX_RESULTS,
            }
        ],
    }

    try:
        response = _openrouter_chat_completion(payload)
        message = response["choices"][0]["message"]
        results = _extract_openrouter_citations(message)
        result = {
            "tool": "internet_search",
            "requesting_agent": requester,
            "query": query,
            "answer": message.get("content", ""),
            "results": results,
            "model": response.get("model", OPENROUTER_SEARCH_MODEL),
            "error": None,
        }
    except (KeyError, json.JSONDecodeError, urllib.error.URLError, TimeoutError) as error:
        result = {
            "tool": "internet_search",
            "requesting_agent": requester,
            "query": query,
            "answer": "",
            "results": [],
            "model": OPENROUTER_SEARCH_MODEL,
            "error": str(error),
        }

    _debug(
        "internet_search:end",
        requester=requester,
        result_count=len(result["results"]),
        error=bool(result.get("error")),
    )
    return result


def initial_search_node(state: MagiState) -> dict:
    _debug("node:initial_search:start", query=state["query"])
    if not MAGI_ENABLE_INTERNET_SEARCH:
        _debug("node:initial_search:skipped", reason="internet_search_disabled")
        return {
            "search_before_discuss": [],
            "shared_search_pool": [],
            "tool_history": [],
            "user_audit_log": [
                {
                    "event": "initial_search_skipped",
                    "reason": "internet_search_disabled",
                }
            ],
        }

    search_record = internet_search(state["query"], requester="system")
    _debug(
        "node:initial_search:end",
        result_count=len(search_record["results"]),
    )
    return {
        "search_before_discuss": [search_record],
        "shared_search_pool": [search_record],
        "tool_history": [search_record],
        "user_audit_log": [
            {
                "event": "initial_search",
                "query": state["query"],
                "result_count": len(search_record["results"]),
            }
        ],
    }


def create_round_snapshot_node(state: MagiState) -> dict:
    round_no = state["current_round"]
    _debug(
        "node:create_round_snapshot:start",
        round=round_no,
        shared_search_count=len(state["shared_search_pool"]),
        history_count=len(state["discussion_history"]),
    )
    snapshot = {
        "round": round_no,
        "query": state["query"],
        "shared_search_results": state["shared_search_pool"],
        "discussion_history": state["discussion_history"],
        "tool_history": state["tool_history"],
    }
    _debug(
        "node:create_round_snapshot:end",
        round=round_no,
        tool_history_count=len(state["tool_history"]),
    )

    return {
        "round_snapshot": snapshot,
        "user_audit_log": [
            {
                "event": "round_snapshot_created",
                "round": round_no,
                "agent_visibility": "agents receive the same immutable snapshot",
            }
        ],
    }


def _json_object(text: str) -> dict:
    _debug("parse_json:start", chars=len(text))
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?", "", cleaned).strip()
    cleaned = re.sub(r"```$", "", cleaned).strip()

    try:
        parsed = json.loads(cleaned)
        _debug("parse_json:end", mode="direct", keys=len(parsed))
        return parsed
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, flags=re.S)
        if not match:
            _debug("parse_json:failed", mode="no_object")
            raise
        parsed = json.loads(match.group(0))
        _debug("parse_json:end", mode="extracted", keys=len(parsed))
        return parsed


def _fallback_explanation_from_text(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip()
    if not cleaned:
        return "The agent did not return a parseable final explanation."

    markers = [
        r"shared_explanation[`*:\s-]+(.+)",
        r"shared explanation[`*:\s-]+(.+)",
        r"explain the fallacy clearly[.`*:\s-]*(.+)",
        r"logical fallacy[`*:\s-]+(.+)",
        r"evaluate the query[`*:\s-]+(.+)",
        r"logic check[`*:\s-]+(.+)",
    ]
    for marker in markers:
        marker_match = re.search(marker, cleaned, flags=re.I)
        if marker_match:
            cleaned = marker_match.group(1).strip()
            break

    schema_noise = [
        "agent",
        "decision",
        "confidence",
        "shared_explanation",
        "objections_to_others",
        "persuasion_message",
        "what_would_change_my_mind",
        "tool_requests",
        "output format",
        "json keys",
    ]
    sentences = re.split(r"(?<=[.!?])\s+", cleaned)
    useful_sentences = [
        sentence
        for sentence in sentences
        if not any(noise in sentence.lower() for noise in schema_noise)
    ]
    if useful_sentences:
        cleaned = " ".join(useful_sentences)

    return cleaned[:900]


def _coerce_agent_output(agent: AgentName, round_no: int, answer: str) -> AgentOutput:
    _debug(
        "coerce_agent_output:start",
        agent=agent,
        round=round_no,
        answer_chars=len(answer),
    )
    try:
        parsed = _json_object(answer)
        parse_error = False
    except json.JSONDecodeError:
        _debug("coerce_agent_output:json_fallback", agent=agent, round=round_no)
        parsed = {
            "decision": "no",
            "confidence": 0.5,
            "shared_explanation": _fallback_explanation_from_text(answer),
            "objections_to_others": {},
            "persuasion_message": "Could not parse structured output; review manually.",
            "what_would_change_my_mind": "A valid structured argument.",
            "tool_requests": [],
            "tool_results": [],
        }
        parse_error = True

    decision = str(parsed.get("decision", "no")).lower()
    if decision not in {"yes", "no"}:
        decision = "no"

    confidence = parsed.get("confidence", 0.5)
    try:
        confidence = max(0.0, min(1.0, float(confidence)))
    except (TypeError, ValueError):
        confidence = 0.5

    objections = parsed.get("objections_to_others", {})
    if isinstance(objections, dict):
        objections_to_others = {str(key): str(value) for key, value in objections.items()}
    elif isinstance(objections, list):
        objections_to_others = {"general": "; ".join(str(item) for item in objections)}
    else:
        objections_to_others = {"general": str(objections)}

    tool_requests = parsed.get("tool_requests", [])
    if not isinstance(tool_requests, list):
        tool_requests = []

    valid_tool_requests = []
    for request in tool_requests:
        if isinstance(request, dict):
            valid_tool_requests.append(request)

    tool_results = parsed.get("tool_results", [])
    if not isinstance(tool_results, list):
        tool_results = []

    valid_tool_results = []
    for result in tool_results:
        if isinstance(result, dict):
            valid_tool_results.append(result)

    output = {
        "round": round_no,
        "agent": agent,
        "decision": decision,
        "confidence": confidence,
        "shared_explanation": str(parsed.get("shared_explanation", "")),
        "objections_to_others": objections_to_others,
        "persuasion_message": str(parsed.get("persuasion_message", "")),
        "what_would_change_my_mind": str(parsed.get("what_would_change_my_mind", "")),
        "tool_requests": valid_tool_requests,
        "tool_results": valid_tool_results,
        "parse_error": parse_error,
    }
    _debug(
        "coerce_agent_output:end",
        agent=agent,
        round=round_no,
        decision=output["decision"],
        confidence=output["confidence"],
        tool_request_count=len(output["tool_requests"]),
    )
    return output


def _repair_notes_from_messages(messages: list) -> str:
    notes = []
    for message in reversed(messages):
        if isinstance(message, ToolMessage):
            notes.append(f"Tool result from {message.name or 'tool'}:\n{message.content}")
        elif isinstance(message, HumanMessage) and not notes:
            notes.append(f"Original task:\n{message.content}")

        if len("\n\n".join(notes)) >= 4000:
            break

    return "\n\n".join(reversed(notes))[:4000]


def _repair_agent_output(
    agent: AgentName,
    messages: list,
    answer: str,
    thinking: str | None,
    round_no: int,
    iteration: int,
) -> tuple[str | None, str, AgentOutput, dict | None]:
    initial_output = _coerce_agent_output(agent, round_no, answer)
    if answer.strip() and not initial_output["parse_error"]:
        return thinking, answer, initial_output, None

    _debug(
        "agent:repair:start",
        agent=agent,
        round=round_no,
        iteration=iteration,
        answer_chars=len(answer),
        thinking_chars=len(thinking or ""),
    )
    repair_source = answer or thinking or _repair_notes_from_messages(messages)
    repair_messages = [
        SystemMessage(
            content=(
                f"You are a JSON formatter for MAGI agent {agent}. "
                "Return one compact JSON object only. Do not reason, explain, "
                "or include markdown."
            )
        ),
        HumanMessage(
            content=(
                "Your previous response did not provide valid final JSON content. "
                "Convert the following notes into final JSON only. Do not include "
                "markdown, analysis, or extra text. Required keys: agent, decision, "
                "confidence, shared_explanation, objections_to_others, "
                "persuasion_message, what_would_change_my_mind.\n\n"
                f"Notes:\n{repair_source[:4000]}"
            )
        ),
    ]
    try:
        repair_response = FORMATTER_LLMS[agent].invoke(repair_messages)
        repair_thinking, repair_answer = _extract_thinking(repair_response)
        repaired_output = _coerce_agent_output(agent, round_no, repair_answer)
    except Exception as exc:
        _debug(
            "agent:repair:error",
            agent=agent,
            round=round_no,
            iteration=iteration,
            error=type(exc).__name__,
        )
        repair_thinking = None
        repair_answer = ""
        repaired_output = initial_output

    repair_log = {
        "round": round_no,
        "agent": agent,
        "iteration": iteration,
        "phase": "repair",
        "thinking": repair_thinking,
    }

    if repaired_output["parse_error"] or not repaired_output["shared_explanation"].strip():
        repaired_output["shared_explanation"] = _fallback_explanation_from_text(repair_source)

    _debug(
        "agent:repair:end",
        agent=agent,
        round=round_no,
        iteration=iteration,
        parse_error=repaired_output["parse_error"],
        explanation_chars=len(repaired_output["shared_explanation"]),
    )
    return thinking, repair_answer, repaired_output, repair_log


class AgentTurnState(TypedDict):
    agent: AgentName
    round_snapshot: dict
    messages: list
    iteration: int
    max_tool_iterations: int
    last_answer: str
    last_thinking: str | None
    last_tool_calls: list
    tool_requests: Annotated[list, operator.add]
    tool_results: Annotated[list, operator.add]
    thinking_log: Annotated[list, operator.add]
    audit_events: Annotated[list, operator.add]
    output: AgentOutput | None


def agent_turn_llm_node(state: AgentTurnState) -> dict:
    agent = state["agent"]
    snapshot = state["round_snapshot"]
    iteration = state["iteration"] + 1

    _debug(
        "agent:llm:start",
        agent=agent,
        round=snapshot["round"],
        iteration=iteration,
    )
    response = _openrouter_agent_chat(
        agent=agent,
        messages=state["messages"],
        reasoning_enabled=OPENROUTER_REASONING,
    )
    _debug(
        "agent:llm:end",
        agent=agent,
        round=snapshot["round"],
        iteration=iteration,
    )

    thinking, answer = _extract_thinking(response)
    tool_calls = getattr(response, "tool_calls", []) or []

    if not answer.strip() and not thinking and not tool_calls and OPENROUTER_REASONING:
        _debug(
            "agent:retry_without_reasoning:start",
            agent=agent,
            round=snapshot["round"],
            iteration=iteration,
        )
        response = _openrouter_agent_chat(
            agent=agent,
            messages=state["messages"],
            reasoning_enabled=False,
        )
        thinking, answer = _extract_thinking(response)
        tool_calls = getattr(response, "tool_calls", []) or []
        _debug(
            "agent:retry_without_reasoning:end",
            agent=agent,
            round=snapshot["round"],
            iteration=iteration,
            thinking_chars=len(thinking or ""),
            answer_chars=len(answer),
            tool_call_count=len(tool_calls),
        )

    _debug(
        "agent:thinking_extracted",
        agent=agent,
        round=snapshot["round"],
        iteration=iteration,
        thinking_chars=len(thinking or ""),
        answer_chars=len(answer),
    )

    if tool_calls:
        _debug(
            "agent:tool_calls_detected",
            agent=agent,
            round=snapshot["round"],
            iteration=iteration,
            tool_call_count=len(tool_calls),
        )

    if not answer.strip() and thinking and not tool_calls:
        _debug(
            "agent:empty_content_with_thinking",
            agent=agent,
            round=snapshot["round"],
            iteration=iteration,
            likely_cause="reasoning_model_did_not_emit_final_content",
        )

    updates = {
        "messages": [*state["messages"], response],
        "iteration": iteration,
        "last_answer": answer,
        "last_thinking": thinking,
        "last_tool_calls": tool_calls,
    }

    if tool_calls and iteration <= state["max_tool_iterations"]:
        updates["thinking_log"] = [
            {
                "round": snapshot["round"],
                "agent": agent,
                "iteration": iteration,
                "phase": "tool_request",
                "thinking": thinking,
            }
        ]

    return updates


def route_agent_turn(state: AgentTurnState) -> str:
    if state["last_tool_calls"] and state["iteration"] <= state["max_tool_iterations"]:
        _debug(
            "agent:route",
            agent=state["agent"],
            round=state["round_snapshot"]["round"],
            route="tools",
            iteration=state["iteration"],
        )
        return "tools"

    _debug(
        "agent:route",
        agent=state["agent"],
        round=state["round_snapshot"]["round"],
        route="finalize_agent",
        iteration=state["iteration"],
    )
    return "finalize_agent"


def agent_turn_tools_node(state: AgentTurnState) -> dict:
    agent = state["agent"]
    snapshot = state["round_snapshot"]
    iteration = state["iteration"]
    tool_messages = []
    tool_requests = []
    tool_results = []
    audit_events = []

    for tool_call in state["last_tool_calls"]:
        tool_name = tool_call.get("name")
        tool_args = tool_call.get("args") or {}
        tool_call_id = tool_call.get("id") or (
            f"{agent}_{snapshot['round']}_{iteration}_{len(tool_messages)}"
        )

        if not MAGI_ENABLE_INTERNET_SEARCH:
            _debug(
                "agent:tool_skipped",
                agent=agent,
                round=snapshot["round"],
                reason="internet_search_disabled",
                tool=tool_name,
            )
            tool_messages.append(
                ToolMessage(
                    content="internet_search is disabled by configuration.",
                    tool_call_id=tool_call_id,
                    name=tool_name or "internet_search",
                )
            )
            continue

        if tool_name != "internet_search":
            _debug(
                "agent:tool_skipped",
                agent=agent,
                round=snapshot["round"],
                reason="unsupported_tool",
                tool=tool_name,
            )
            tool_messages.append(
                ToolMessage(
                    content=f"Unsupported tool: {tool_name}",
                    tool_call_id=tool_call_id,
                    name=tool_name or "unknown_tool",
                )
            )
            continue

        query = str(tool_args.get("query", "")).strip()
        if not query:
            _debug(
                "agent:tool_skipped",
                agent=agent,
                round=snapshot["round"],
                reason="empty_query",
                query=query,
            )
            tool_messages.append(
                ToolMessage(
                    content="internet_search requires a non-empty query.",
                    tool_call_id=tool_call_id,
                    name=tool_name,
                )
            )
            continue

        _debug(
            "agent:tool:start",
            agent=agent,
            round=snapshot["round"],
            iteration=iteration,
            query=query,
        )
        tool_record = internet_search(query, requester=agent)
        tool_requests.append(
            {
                "tool": tool_name,
                "query": query,
                "id": tool_call_id,
            }
        )
        tool_results.append(tool_record)
        audit_events.append(
            {
                "event": "agent_used_tool_same_round",
                "round": snapshot["round"],
                "agent": agent,
                "iteration": iteration,
                "tool": tool_name,
                "query": query,
            }
        )
        tool_messages.append(
            ToolMessage(
                content=json.dumps(tool_record["results"], ensure_ascii=False),
                tool_call_id=tool_call_id,
                name=tool_name,
            )
        )
        _debug(
            "agent:tool:end",
            agent=agent,
            round=snapshot["round"],
            iteration=iteration,
            query=query,
        )

    if not tool_messages:
        _debug(
            "agent:no_new_tool_results",
            agent=agent,
            round=snapshot["round"],
            iteration=iteration,
        )

    return {
        "messages": [*state["messages"], *tool_messages],
        "tool_requests": tool_requests,
        "tool_results": tool_results,
        "audit_events": audit_events,
    }


def finalize_agent_turn_node(state: AgentTurnState) -> dict:
    agent = state["agent"]
    snapshot = state["round_snapshot"]

    if state["last_tool_calls"] and state["iteration"] > state["max_tool_iterations"]:
        _debug(
            "agent:max_tool_iterations_reached",
            agent=agent,
            round=snapshot["round"],
            pending_tool_requests=len(state["last_tool_calls"]),
        )

    thinking, answer, output, repair_log = _repair_agent_output(
        agent=agent,
        messages=state["messages"],
        answer=state["last_answer"],
        thinking=state["last_thinking"],
        round_no=snapshot["round"],
        iteration=state["iteration"],
    )

    output["tool_requests"] = state["tool_requests"] or output["tool_requests"]
    output["tool_results"] = state["tool_results"]
    thinking_log = []
    if repair_log:
        thinking_log.append(repair_log)
    thinking_log.append(
        {
            "round": snapshot["round"],
            "agent": agent,
            "iteration": state["iteration"],
            "phase": "final",
            "thinking": thinking,
        }
    )

    _debug(
        "agent:iteration_result",
        agent=agent,
        round=snapshot["round"],
        iteration=state["iteration"],
        phase="final",
        decision=output["decision"],
        confidence=output["confidence"],
        tool_request_count=len(state["tool_requests"]),
    )

    return {
        "output": output,
        "thinking_log": thinking_log,
    }


agent_turn_builder = StateGraph(AgentTurnState)
agent_turn_builder.add_node("agent", agent_turn_llm_node)
agent_turn_builder.add_node("tools", agent_turn_tools_node)
agent_turn_builder.add_node("finalize_agent", finalize_agent_turn_node)
agent_turn_builder.add_edge(START, "agent")
agent_turn_builder.add_conditional_edges(
    "agent",
    route_agent_turn,
    {
        "tools": "tools",
        "finalize_agent": "finalize_agent",
    },
)
agent_turn_builder.add_edge("tools", "agent")
agent_turn_builder.add_edge("finalize_agent", END)
agent_turn_graph = agent_turn_builder.compile()


def _agent_node(agent: AgentName, state: MagiState) -> dict:
    snapshot = state["round_snapshot"]
    agent_def = AGENTS[agent]
    max_tool_iterations = MAGI_MAX_TOOL_ITERATIONS if MAGI_ENABLE_INTERNET_SEARCH else 0
    _debug(
        "agent:start",
        agent=agent,
        round=snapshot["round"],
        max_tool_iterations=max_tool_iterations,
    )

    system_prompt = SystemMessage(
        content=f"""
You are {agent}, one of three MAGI deliberation agents.

Role: {agent_def["role"]}
Focus: {agent_def["focus"]}
Priority: {agent_def["priority"]}
Tool availability: internet_search is {"enabled" if MAGI_ENABLE_INTERNET_SEARCH else "disabled"}.

Rules:
- You must strictly act as {agent}. Keep your evaluation aligned with this role, focus, and priority.
- You are debating with the other two MAGI agents. Challenge prior arguments, try to persuade them, and be willing to change your decision if their evidence is stronger.
- Provide a discussion-visible explanation that future agents may inspect.
- If internet_search is enabled and you need search before your final answer, call the available tool.
- If internet_search is disabled, do not request tools; reason only from the provided snapshot and your existing knowledge.
- If same-round tool results are provided, use them before producing your final answer.
- Output JSON only, with exactly these keys:
  agent, decision, confidence, shared_explanation, objections_to_others,
  persuasion_message, what_would_change_my_mind.
- decision must be "yes" or "no".
- confidence must be a number from 0 to 1.
""".strip()
    )

    user_message = HumanMessage(
        content=(
            "Evaluate this immutable MAGI round snapshot.\n\n"
            f"{json.dumps(snapshot, ensure_ascii=False, indent=2)}"
        )
    )

    messages = [system_prompt, user_message]
    agent_turn_result = agent_turn_graph.invoke(
        {
            "agent": agent,
            "round_snapshot": snapshot,
            "messages": messages,
            "iteration": 0,
            "max_tool_iterations": max_tool_iterations,
            "last_answer": "",
            "last_thinking": None,
            "last_tool_calls": [],
            "tool_requests": [],
            "tool_results": [],
            "thinking_log": [],
            "audit_events": [],
            "output": None,
        }
    )
    output = agent_turn_result["output"]
    if output is None:
        raise RuntimeError(f"{agent} did not produce an output")

    _debug(
        "agent:end",
        agent=agent,
        round=snapshot["round"],
        decision=output["decision"],
        confidence=output["confidence"],
        tool_result_count=len(output["tool_results"]),
    )

    return {
        "agent_outputs": [output],
        "thinking_log": agent_turn_result["thinking_log"],
        "user_audit_log": [
            {
                "event": "agent_completed_round",
                "round": snapshot["round"],
                "agent": agent,
                "decision": output["decision"],
                "confidence": output["confidence"],
                "same_round_tool_result_count": len(output["tool_results"]),
            },
            *agent_turn_result["audit_events"],
        ],
    }


def melchior_node(state: MagiState) -> dict:
    _debug("node:melchior:dispatch", round=state["current_round"])
    return _agent_node("melchior", state)


def balthasar_node(state: MagiState) -> dict:
    _debug("node:balthasar:dispatch", round=state["current_round"])
    return _agent_node("balthasar", state)


def casper_node(state: MagiState) -> dict:
    _debug("node:casper:dispatch", round=state["current_round"])
    return _agent_node("casper", state)


def record_round_node(state: MagiState) -> dict:
    round_no = state["current_round"]
    _debug("node:record_round:start", round=round_no)
    round_outputs = [item for item in state["agent_outputs"] if item["round"] == round_no]
    round_tool_records = [
        result for output in round_outputs for result in output.get("tool_results", [])
    ]

    round_record = {
        "round": round_no,
        "agent_outputs": round_outputs,
        "tool_results": round_tool_records,
    }
    _debug(
        "node:record_round:end",
        round=round_no,
        agent_output_count=len(round_outputs),
        tool_result_count=len(round_tool_records),
    )

    return {
        "shared_search_pool": round_tool_records,
        "tool_history": round_tool_records,
        "discussion_history": [round_record],
        "user_audit_log": [
            {
                "event": "round_tools_persisted",
                "round": round_no,
                "tool_result_count": len(round_tool_records),
            },
            {
                "event": "round_recorded",
                "round": round_no,
                "tool_result_count": len(round_tool_records),
            }
        ],
    }


def _latest_votes(state: MagiState) -> list[AgentOutput]:
    round_no = state["current_round"]
    votes = [item for item in state["agent_outputs"] if item["round"] == round_no]
    _debug("latest_votes", round=round_no, vote_count=len(votes))
    return votes


def _has_consensus(votes: list[AgentOutput]) -> bool:
    has_consensus = len(votes) == 3 and len({vote["decision"] for vote in votes}) == 1
    _debug("consensus_check", vote_count=len(votes), has_consensus=has_consensus)
    return has_consensus


def route_after_round(state: MagiState) -> str:
    _debug("route_after_round:start", round=state["current_round"])
    votes = _latest_votes(state)
    if _has_consensus(votes):
        _debug("route_after_round:end", route="finalize", reason="consensus")
        return "finalize"

    if state["current_round"] >= state["max_rounds"]:
        _debug("route_after_round:end", route="finalize", reason="max_rounds")
        return "finalize"

    _debug("route_after_round:end", route="next_round")
    return "next_round"


def next_round_node(state: MagiState) -> dict:
    next_round = state["current_round"] + 1
    _debug("node:next_round", from_round=state["current_round"], to_round=next_round)
    return {
        "current_round": next_round,
        "user_audit_log": [{"event": "next_round", "round": next_round}],
    }


def finalize_node(state: MagiState) -> dict:
    _debug("node:finalize:start", round=state["current_round"])
    votes = _latest_votes(state)
    vote_breakdown = {vote["agent"]: vote["decision"] for vote in votes}
    yes_count = sum(1 for vote in votes if vote["decision"] == "yes")
    no_count = sum(1 for vote in votes if vote["decision"] == "no")

    if _has_consensus(votes):
        result = votes[0]["decision"]
        method = "consensus"
    else:
        result = "yes" if yes_count > no_count else "no"
        method = "majority_vote"

    final_decision = {
        "result": result,
        "method": method,
        "round_count": state["current_round"],
        "vote_breakdown": vote_breakdown,
        "summary": (
            f"MAGI decided {result.upper()} by {method} after "
            f"{state['current_round']} round(s)."
        ),
    }
    _debug(
        "node:finalize:end",
        result=final_decision["result"],
        method=final_decision["method"],
        round_count=final_decision["round_count"],
    )

    return {
        "final_decision": final_decision,
        "user_audit_log": [{"event": "final_decision", **final_decision}],
    }


builder = StateGraph(MagiState)
builder.add_node("initial_search", initial_search_node)
builder.add_node("create_round_snapshot", create_round_snapshot_node)
builder.add_node("melchior", melchior_node)
builder.add_node("balthasar", balthasar_node)
builder.add_node("casper", casper_node)
builder.add_node("record_round", record_round_node)
builder.add_node("next_round", next_round_node)
builder.add_node("finalize", finalize_node)

builder.add_edge(START, "initial_search")
builder.add_edge("initial_search", "create_round_snapshot")
builder.add_edge("create_round_snapshot", "melchior")
builder.add_edge("create_round_snapshot", "balthasar")
builder.add_edge("create_round_snapshot", "casper")
builder.add_edge(
    ["melchior", "balthasar", "casper"],
    "record_round",
)
builder.add_conditional_edges(
    "record_round",
    route_after_round,
    {
        "next_round": "next_round",
        "finalize": "finalize",
    },
)
builder.add_edge("next_round", "create_round_snapshot")
builder.add_edge("finalize", END)

graph = builder.compile()


def run_magi(query: str, max_rounds: int = 2) -> MagiState:
    _debug("run_magi:start", query=query, max_rounds=max_rounds)
    result = graph.invoke(
        {
            "query": query,
            "current_round": 1,
            "max_rounds": max_rounds,
            "search_before_discuss": [],
            "shared_search_pool": [],
            "discussion_history": [],
            "tool_history": [],
            "user_audit_log": [],
            "thinking_log": [],
            "agent_outputs": [],
            "round_snapshot": {},
            "final_decision": None,
        }
    )
    _debug(
        "run_magi:end",
        final_result=result["final_decision"]["result"] if result["final_decision"] else None,
        method=result["final_decision"]["method"] if result["final_decision"] else None,
    )
    return result


if __name__ == "__main__":
    # demo_query = (
    #     "Should this MVP expose raw model thinking to the user while keeping it "
    #     "hidden from future agent rounds?"
    # )
    # demo_query = "if cat is creature and human is creature, so cat is human."
    demo_query = "你認為EVA中的MAGI系統現在可能實現嗎？"

    result = run_magi(demo_query, max_rounds=MAGI_MAX_ROUNDS)

    print("=== Query ===")
    print(result["query"])

    print("\n=== Initial Search ===")
    print(json.dumps(result["search_before_discuss"], ensure_ascii=False, indent=2))

    print("\n=== Rounds ===")
    for round_record in result["discussion_history"]:
        print(f"\nRound {round_record['round']}")
        for output in round_record["agent_outputs"]:
            print(
                f"- {output['agent']}: {output['decision']} "
                f"(confidence={output['confidence']:.2f})"
            )
            if output.get("parse_error"):
                print("  parse_error: true")
            print(f"  explanation: {output['shared_explanation']}")
            if output["tool_requests"]:
                print(f"  tool_requests: {output['tool_requests']}")
            if output["tool_results"]:
                print(f"  tool_results: {output['tool_results']}")

    print("\n=== Thinking Log (user-visible only) ===")
    for item in result["thinking_log"]:
        print(
            f"\nRound {item['round']} / {item['agent']} / "
            f"iteration {item['iteration']} / {item['phase']}"
        )
        print(item["thinking"] or "(provider did not return thinking)")

    print("\n=== Final Decision ===")
    print(json.dumps(result["final_decision"], ensure_ascii=False, indent=2))

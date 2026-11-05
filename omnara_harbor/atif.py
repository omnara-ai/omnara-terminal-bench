from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import httpx

ATIF_VERSION = "ATIF-v1.6"


@dataclass
class Pricing:

    prompt: float
    completion: float
    cache_read: float
    cache_write: float
    long_threshold: int | None = None
    long: Pricing | None = None

    def cost(self, usage: dict[str, Any]) -> float:
        total_in = usage.get("input_tokens_total") or 0
        tier = self.long if self.long and self.long_threshold and total_in >= self.long_threshold else self
        cache_read = usage.get("cache_read_input_tokens") or 0
        cache_write = usage.get("cache_write_input_tokens") or 0
        uncached = max(total_in - cache_read - cache_write, 0)
        return (
            uncached * tier.prompt
            + cache_read * tier.cache_read
            + cache_write * tier.cache_write
            + (usage.get("output_tokens_total") or 0) * tier.completion
        )


async def openrouter_pricing(model: str) -> Pricing | None:
    try:
        async with httpx.AsyncClient(timeout=30) as http:
            models = (await http.get("https://openrouter.ai/api/v1/models")).json()["data"]
    except (httpx.HTTPError, KeyError, ValueError):
        return None
    for entry in models:
        if entry.get("id") != model:
            continue
        p = entry.get("pricing") or {}

        def tier(src: dict[str, Any]) -> Pricing:
            prompt = float(src.get("prompt", 0))
            return Pricing(
                prompt=prompt,
                completion=float(src.get("completion", 0)),
                cache_read=float(src.get("input_cache_read", prompt)),
                cache_write=float(src.get("input_cache_write", prompt)),
            )

        base = tier(p)
        for override in p.get("overrides") or []:
            if "min_prompt_tokens" in override:
                base.long_threshold = int(override["min_prompt_tokens"])
                base.long = tier({**p, **override})
        return base
    return None


@dataclass
class Totals:
    input_tokens: int = 0
    cached_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    cost_usd: float | None = None
    model_calls: int = 0
    stop_reason: str | None = None
    final_message: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


def _text(blocks: list[dict[str, Any]], kind: str) -> str:
    return "\n".join(b.get("text", "") for b in blocks if b.get("type") == kind and b.get("text"))


def _tool_result_content(blocks: list[dict[str, Any]]) -> str:
    parts = []
    for block in blocks:
        if block.get("type") == "text":
            parts.append(block.get("text", ""))
        elif block.get("type") == "structured_data":
            parts.append(json.dumps(block.get("value"), ensure_ascii=False))
        else:
            parts.append(json.dumps(block, ensure_ascii=False))
    return "\n".join(parts)


def build_trajectory(
    events: list[dict[str, Any]],
    *,
    agent_name: str,
    agent_version: str,
    model_name: str,
    session_id: str,
    pricing: Pricing | None,
) -> tuple[dict[str, Any], Totals]:
    steps: list[dict[str, Any]] = []
    by_call: dict[str, dict[str, Any]] = {}
    totals = Totals(cost_usd=0.0 if pricing else None)

    for event in events:
        kind = event.get("event_kind")
        blocks = event.get("content_blocks") or []
        if kind == "agent_input":
            text = _text(blocks, "text")
            if text:
                steps.append({"step_id": len(steps) + 1, "timestamp": event["created_at"], "source": "user", "message": text})
        elif kind == "model_output":
            usage = event.get("usage") or {}
            calls = [b for b in blocks if b.get("type") == "tool_call"]
            step: dict[str, Any] = {
                "step_id": len(steps) + 1,
                "timestamp": event["created_at"],
                "source": "agent",
                "model_name": model_name,
                "message": _text(blocks, "text"),
                "llm_call_count": 1,
                "extra": {"stop_reason": event.get("stop_reason")},
            }
            reasoning = _text(blocks, "reasoning")
            if reasoning:
                step["reasoning_content"] = reasoning
            if calls:
                step["tool_calls"] = [
                    {
                        "tool_call_id": c["tool_call_id"],
                        "function_name": c["name"],
                        "arguments": c.get("input") if isinstance(c.get("input"), dict) else {"input": c.get("input")},
                    }
                    for c in calls
                ]
                step["observation"] = {"results": []}
                for c in calls:
                    by_call[c["tool_call_id"]] = step
            cost = pricing.cost(usage) if pricing else None
            step["metrics"] = {
                "prompt_tokens": usage.get("input_tokens_total"),
                "completion_tokens": usage.get("output_tokens_total"),
                "cached_tokens": usage.get("cache_read_input_tokens"),
                "cost_usd": cost,
                "extra": {"reasoning_output_tokens": usage.get("reasoning_output_tokens")},
            }
            steps.append(step)
            totals.model_calls += 1
            totals.input_tokens += usage.get("input_tokens_total") or 0
            totals.cached_tokens += usage.get("cache_read_input_tokens") or 0
            totals.output_tokens += usage.get("output_tokens_total") or 0
            totals.reasoning_tokens += usage.get("reasoning_output_tokens") or 0
            if cost is not None and totals.cost_usd is not None:
                totals.cost_usd += cost
            totals.stop_reason = event.get("stop_reason")
            if step["message"]:
                totals.final_message = step["message"]
        elif kind == "tool_result":
            owner = by_call.get(event.get("tool_call_id", ""))
            if owner is not None:
                owner["observation"]["results"].append(
                    {
                        "source_call_id": event["tool_call_id"],
                        "content": _tool_result_content(blocks),
                        "extra": {"outcome": event.get("outcome")},
                    }
                )

    trajectory = {
        "schema_version": ATIF_VERSION,
        "session_id": session_id,
        "agent": {"name": agent_name, "version": agent_version, "model_name": model_name},
        "steps": steps,
        "final_metrics": {
            "total_prompt_tokens": totals.input_tokens,
            "total_completion_tokens": totals.output_tokens,
            "total_cached_tokens": totals.cached_tokens,
            "total_cost_usd": totals.cost_usd,
            "total_steps": len(steps),
            "extra": {"reasoning_output_tokens": totals.reasoning_tokens, "stop_reason": totals.stop_reason},
        },
    }
    return trajectory, totals

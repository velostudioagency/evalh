#!/usr/bin/env python3
"""Render golden qwen3 traces from conversation fixtures with the vendored Jinja template."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

try:
	from jinja2 import Environment
except ImportError:
	print(
		"jinja2 is required to generate trace goldens; install it with: python -m pip install jinja2",
		file=sys.stderr,
	)
	sys.exit(3)


def template_messages(fixture: dict[str, Any]) -> list[dict[str, Any]]:
	system_prompt = fixture.get("systemPrompt", "")
	tools = fixture.get("tools", [])
	messages: list[dict[str, Any]] = []
	if system_prompt or not tools:
		messages.append({"role": "system", "content": system_prompt})
	for message in fixture["messages"]:
		role = message["role"]
		if role == "assistant":
			messages.append(
				{
					"role": "assistant",
					"content": message.get("content") or "",
					"reasoning_content": message.get("reasoning_content"),
					"tool_calls": [
						{
							"id": call["id"],
							"type": "function",
							"function": {"name": call["name"], "arguments": call["arguments"]},
						}
						for call in message.get("toolCalls", [])
					],
				}
			)
		else:
			messages.append({"role": role, "content": message["content"]})
	return messages


def main(argv: list[str]) -> int:
	if len(argv) != 2:
		print("usage: python scripts/gen-trace-goldens.py <output-dir>", file=sys.stderr)
		return 2
	package_root = Path(__file__).resolve().parent.parent
	template_path = package_root / "templates" / "qwen3" / "4b.jinja"
	conversations_dir = package_root / "test" / "fixtures" / "conversations"
	output_dir = Path(argv[1]).resolve()

	template_text = template_path.read_text(encoding="utf-8").replace("\r\n", "\n")
	render = Environment().from_string(template_text)

	names = sorted(path.stem for path in conversations_dir.glob("*.json"))
	if not names:
		print(f"no conversation fixtures found in {conversations_dir}", file=sys.stderr)
		return 2

	output_dir.mkdir(parents=True, exist_ok=True)
	for name in names:
		fixture = json.loads((conversations_dir / f"{name}.json").read_text(encoding="utf-8"))
		text = render.render(
			messages=template_messages(fixture),
			tools=fixture.get("tools", []),
			add_generation_prompt=False,
		)
		with (output_dir / f"{name}.txt").open("w", encoding="utf-8", newline="") as handle:
			handle.write(text)
		print(f"{name}.txt")
	return 0


if __name__ == "__main__":
	sys.exit(main(sys.argv))

"""Jevo's additions to the router: a short skill index, one copy per skill, long prompts,
and one load per session with a review after compaction or every ``REVIEW_EVERY`` prompts.

Everything here is off unless Jevo sets its variables, so the upstream behaviour is unchanged
for anyone else running these scripts:

  JEV_ROUTER_INDEX      path of the short skill index (one line per skill, user-editable)
  JEV_ROUTER_STATE_DIR  directory of per-session state (which skill is loaded, turn count)
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from scripts.roster import Skill

#: Index line length. Ranking on 150-character lines picked the same skill as full descriptions
#: on 7 of 7 probe prompts with ~65% fewer Jev input tokens (measured 2026-10-20).
INDEX_CHARS = 150
#: The three finalists are judged on the start of their body, not all of it (median 10.6k chars).
RERANK_BODY_CHARS = 1500
#: A long prompt is pasted material; its request is almost always at the start or the end.
PROMPT_EDGE_CHARS = 2000
#: Prompts after which the loaded skill is reviewed even without a compaction.
REVIEW_EVERY = 20
#: Prompts a review reads, the newest included.
REVIEW_PROMPTS = 3

_SESSION_RE = re.compile(r"\A[A-Za-z0-9_-]{1,128}\Z")


def short_line(description: str) -> str:
    """The description cut to ``INDEX_CHARS`` at a word boundary."""
    text = " ".join(description.split())
    if len(text) <= INDEX_CHARS:
        return text
    cut = text[:INDEX_CHARS].rsplit(" ", 1)[0]
    return cut.rstrip(",;:") + "…"


def dedupe(skills: Sequence[Skill]) -> list[Skill]:
    """One entry per identical skill. A plugin's copy wins: it updates with the plugin, and two
    copies of one skill would take two of the three shortlist places."""
    best: dict[tuple[str, str], Skill] = {}
    for skill in skills:
        key = (skill.description, skill.body)
        kept = best.get(key)
        if kept is None or (skill.source == "plugin" and kept.source != "plugin"):
            best[key] = skill
    keep = {id(s) for s in best.values()}
    return [s for s in skills if id(s) in keep]


def load_index(path: Path, skills: Sequence[Skill]) -> dict[str, str]:
    """Name -> index line. A line is regenerated when its skill's description changes, unless
    someone edited it by hand (``line`` differs from the ``auto`` it was generated as)."""
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        stored = {}
    if not isinstance(stored, dict):
        stored = {}
    index: dict[str, dict[str, str]] = {}
    for skill in skills:
        auto = short_line(skill.description)
        entry = stored.get(skill.name)
        edited = (
            isinstance(entry, dict)
            and isinstance(entry.get("line"), str)
            and entry.get("line") != entry.get("auto")
        )
        index[skill.name] = {"line": entry["line"] if edited else auto, "auto": auto}
    if index != stored:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(index, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
            os.replace(tmp, path)
        except OSError:
            pass  # a read-only data dir costs the cache, not the turn
    return {name: entry["line"] for name, entry in index.items()}


def ranking_roster(skills: Sequence[Skill], lines: Mapping[str, str]) -> list[Skill]:
    """What Jev sees: index lines for descriptions, the start of each body."""
    return [
        dataclasses.replace(
            s, description=lines.get(s.name, s.description), body=s.body[:RERANK_BODY_CHARS]
        )
        for s in skills
    ]


def clip_prompt(prompt: str) -> str:
    if len(prompt) <= 2 * PROMPT_EDGE_CHARS:
        return prompt
    return f"{prompt[:PROMPT_EDGE_CHARS]}\n[…]\n{prompt[-PROMPT_EDGE_CHARS:]}"


def state_path(env: Mapping[str, str], session: str) -> Path | None:
    root = (env.get("JEV_ROUTER_STATE_DIR") or "").strip()
    if not root or not _SESSION_RE.match(session):
        return None
    return Path(root) / f"{session}.json"


def read_state(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_state(path: Path | None, state: Mapping[str, Any]) -> None:
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


def mark_compacted(env: Mapping[str, str], payload: Mapping[str, Any]) -> None:
    """SessionStart with source ``compact``: the loaded skill's text was summarised away."""
    if payload.get("source") != "compact":
        return
    path = state_path(env, str(payload.get("session_id") or ""))
    state = read_state(path)
    if state.get("loaded"):
        state["compacted"] = True
        write_state(path, state)


def recent_prompts(transcript: str, limit: int) -> list[str]:
    """The last ``limit`` prompts the user typed, oldest first. Tool results and hook text are
    list-shaped or flagged; a typed prompt is a ``user`` line whose content is a string."""
    found: list[str] = []
    try:
        with open(transcript, encoding="utf-8") as handle:
            for line in handle:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                message = row.get("message") if isinstance(row, dict) else None
                if (
                    row.get("type") == "user"
                    and not row.get("isMeta")
                    and not row.get("isCompactSummary")
                    and isinstance(message, dict)
                    and isinstance(message.get("content"), str)
                ):
                    found.append(message["content"])
    except OSError:
        return []
    return found[-limit:]


def review_due(state: Mapping[str, Any]) -> bool:
    return bool(state.get("loaded")) and (
        bool(state.get("compacted")) or int(state.get("turns") or 0) >= REVIEW_EVERY
    )


def review_request(payload: Mapping[str, Any], prompt: str) -> str:
    """The newest prompt plus the ones before it, so a review judges where the work is going."""
    earlier = recent_prompts(str(payload.get("transcript_path") or ""), REVIEW_PROMPTS)
    if earlier and earlier[-1] == prompt:
        earlier = earlier[:-1]
    parts = [*earlier[-(REVIEW_PROMPTS - 1) :], prompt]
    return "\n\n---\n\n".join(clip_prompt(p) for p in parts)


def decide(state: dict[str, Any], picked: str | None, reviewing: bool) -> tuple[str, str | None]:
    """``(action, skill)`` for this turn, and updates ``state`` in place.

    load    put ``skill`` in the turn (the first fit, or a review's new or re-loaded pick)
    drop    tell Claude to stop following ``skill``
    none    say nothing (no fit, or a skill is loaded and no review is due)

    A loaded skill changes only at a review: switching on every prompt would reload skills as
    prompts flip between them. ``turns`` counts prompts since the last load or review.
    """
    loaded = state.get("loaded")
    compacted = bool(state.get("compacted"))
    state["compacted"] = False
    if loaded and not reviewing:
        state["turns"] = int(state.get("turns") or 0) + 1
        return "none", None
    if picked is None:
        if reviewing:
            state["turns"] = 0
            state["loaded"] = None
            return "drop", loaded
        state["turns"] = int(state.get("turns") or 0) + 1
        return "none", None
    state["turns"] = 0
    if picked == loaded and not compacted:
        return "none", None
    state["loaded"] = picked
    return "load", picked


def drop_block(name: str) -> str:
    return (
        "\n\n<skill_relevance>\n"
        f"The skill '{name}' that was loaded earlier in this conversation no longer fits where "
        "the work has gone. Stop following its instructions.\n"
        "</skill_relevance>"
    )

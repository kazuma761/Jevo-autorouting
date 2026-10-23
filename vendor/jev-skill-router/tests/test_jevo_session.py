"""Jevo's session behaviour end to end through route.route(), with a fake Jev.

Plain asserts, no framework: `python3 -I tests/test_jevo_session.py` prints `jevo session ok`.
Run by Jevo's `src/skillroute.test.ts`.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts import jevo_session, route  # noqa: E402
from scripts.roster import Skill  # noqa: E402


class FakeJev:
    """Picks ``target`` (None: the gate says no skill is needed). ``fail`` raises instead."""

    def __init__(self) -> None:
        self.target: str | None = None
        self.fail = False
        self.requests: list[str] = []

    def ask(self, state, questions, *, model, timeout):  # noqa: ANN001
        if self.fail:
            raise RuntimeError("jev down")
        self.requests.append(state["request"] if "request" in state else json.dumps(state))
        answers: dict = {}
        if any(key.startswith("gate::") for key in questions):
            names = list(questions["which"]["criteria"])
            probs = {n: 0.01 for n in names}
            if self.target in probs:
                probs[self.target] = 0.9
            answers["which"] = {"probabilities": probs}
            need = self.target is not None
            for key in questions:
                if key.startswith("gate::"):
                    inverted = key.endswith("prose_suffices")
                    answers[key] = {"noul": (0.1 if need else 0.9) if inverted else (0.9 if need else 0.1)}
        else:
            answers["which"] = {"choice": self.target}
            for key in questions:
                if key.startswith("fits::"):
                    answers[key] = {"noul": 0.9 if key == f"fits::{self.target}" else 0.05}
        return {"answers": answers}


def skill(home: Path, name: str, description: str, body: str) -> None:
    folder = home / ".claude" / "skills" / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "SKILL.md").write_text(f"---\ndescription: {description}\n---\n{body}\n", encoding="utf-8")


def main() -> None:
    # Pure helpers.
    assert jevo_session.short_line("a " * 200).endswith("…")
    assert len(jevo_session.short_line("word " * 100)) <= jevo_session.INDEX_CHARS
    # No space in the first 150 characters (a long URL): still a hard 150, ellipsis included.
    assert len(jevo_session.short_line("https://example.com/" + "a" * 300)) == jevo_session.INDEX_CHARS
    assert jevo_session.clip_prompt("x" * 10) == "x" * 10
    clipped = jevo_session.clip_prompt("a" * 3000 + "b" * 3000)
    assert clipped.startswith("a" * 2000) and clipped.endswith("b" * 2000) and len(clipped) < 4100
    twins = [
        Skill("video", "user", "/u", "d", "b"),
        Skill("hyper:video", "plugin", "/p", "d", "b"),
        Skill("other", "user", "/o", "d2", "b"),
    ]
    assert [s.name for s in jevo_session.dedupe(twins)] == ["hyper:video", "other"]

    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        skill(home, "alpha", "Reviews code for bugs. " + "Long detail. " * 30, "ALPHA BODY")
        skill(home, "beta", "Deploys web services.", "BETA BODY")
        index = home / "index.json"
        env = {
            "HOME": str(home),
            "JEV_ROUTER": "inject",
            "JEV_ROUTER_HINT": "directive",
            "TYPESAFE_API_KEY": "k",
            "JEV_ROUTER_INDEX": str(index),
            "JEV_ROUTER_STATE_DIR": str(home / "state"),
        }
        jev = FakeJev()

        def turn(prompt: str, target: str | None, session: str = "s1") -> str:
            jev.target = target
            payload = {"session_id": session, "cwd": str(home), "prompt": prompt}
            out, _ = route.route(json.dumps(payload), env, client=jev)
            return json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""

        def state(session: str = "s1") -> dict:
            return json.loads((home / "state" / f"{session}.json").read_text())

        # Loaded once, then silent while it still fits.
        assert '<skill name="alpha">' in turn("review my diff", "alpha")
        assert turn("and the next file", "alpha") == ""
        assert state()["loaded"] == "alpha"

        # The index holds short lines; a hand edit survives a rebuild.
        lines = json.loads(index.read_text())
        assert len(lines["alpha"]["line"]) <= jevo_session.INDEX_CHARS
        lines["alpha"]["line"] = "MY OWN WORDS"
        index.write_text(json.dumps(lines))
        assert turn("one more", "alpha") == ""
        assert json.loads(index.read_text())["alpha"]["line"] == "MY OWN WORDS"

        # A different skill fitting a normal prompt does not swap skills: that waits for a
        # review, or prompts flipping A -> B -> A would load A twice.
        assert turn("now deploy it", "beta") == ""
        assert turn("back to the review", "alpha") == ""
        assert state()["loaded"] == "alpha"

        # Compaction: the next prompt is a review, and the skill that fits now is loaded.
        route.route(json.dumps({"hook_event_name": "SessionStart", "source": "compact", "session_id": "s1"}), env)
        assert state()["compacted"] is True
        assert '<skill name="beta">' in turn("continue the deploy", "beta")
        assert state()["turns"] == 0 and state()["compacted"] is False

        # The 20-prompt count starts at the load, not at the session start: a skill loaded after
        # 19 prompts that fit nothing is not reviewed on the very next prompt.
        for i in range(jevo_session.REVIEW_EVERY - 1):
            assert turn(f"chat {i}", None, "s2") == ""
        assert '<skill name="alpha">' in turn("review my diff", "alpha", "s2")
        assert turn("thanks", None, "s2") == "" and state("s2")["loaded"] == "alpha"

        # A Jev failure during a review changes nothing.
        for i in range(jevo_session.REVIEW_EVERY):
            turn(f"deploy step {i}", "beta")
        jev.fail = True
        assert turn("what now?", None) == "" and state()["loaded"] == "beta"
        jev.fail = False

        # The review after 20 prompts finds nothing fits: Claude is told to stop following it.
        dropped = turn("let's write the blog post", None)
        assert "Stop following" in dropped and "beta" in dropped
        assert state()["loaded"] is None

        # A long prompt is routed on its start and end instead of being skipped.
        assert '<skill name="alpha">' in turn("review this: " + "x" * 6000 + " for bugs", "alpha")
        assert len(jev.requests[-1]) < 4200, len(jev.requests[-1])

        # Without Jevo's variables nothing is remembered: every fitting prompt loads.
        plain = {k: v for k, v in env.items() if k not in ("JEV_ROUTER_STATE_DIR", "JEV_ROUTER_INDEX")}
        env.clear()
        env.update(plain)
        assert '<skill name="alpha">' in turn("review", "alpha")
        assert '<skill name="alpha">' in turn("review again", "alpha")

    print("jevo session ok")


if __name__ == "__main__":
    main()

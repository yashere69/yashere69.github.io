"""Run a tool's command-line entry point and capture what it prints.

The page runs this file in Pyodide; the tests run the same file in CPython and compare the
two outputs, so what the page shows is what `pip install` + the terminal would show.
"""

import contextlib
import glob
import importlib
import io
import sys
import time
import traceback

MODULES = {"skill-preflight": "skill_preflight"}


def expand(argv):
    """Expand shell-style globs the way a POSIX shell would, since there is no shell here."""
    out = []
    for a in argv:
        if not a.startswith("-") and any(c in a for c in "*?["):
            out += sorted(glob.glob(a)) or [a]
        else:
            out.append(a)
    return out


def run_cli(tool, argv):
    """Return (stdout, stderr, exit code, milliseconds)."""
    mod = importlib.import_module(MODULES.get(tool, tool) + ".cli")
    out, err = io.StringIO(), io.StringIO()
    code = 0
    t0 = time.perf_counter()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            r = mod.main(expand(list(argv)))
            code = r if isinstance(r, int) else 0
        except SystemExit as e:
            if e.code is None:
                code = 0
            elif isinstance(e.code, int):
                code = e.code
            else:
                print(e.code, file=sys.stderr)
                code = 1
        except Exception:
            traceback.print_exc()
            code = 1
    return out.getvalue(), err.getvalue(), code, (time.perf_counter() - t0) * 1000


def line(text, style="label in Hindi", reply=None):
    """The page's message line: parda redacts, a model rewrites the tokens, two restores.

    The rewrite styles are parda's own benchmark transforms (parda.bench.TRANSFORMS); the
    "model" is parda.bench.reply_for, which repeats every token back. No model is called.
    """
    import json

    from parda import Parda
    from parda.bench import TRANSFORMS, _exact_restore, reply_for

    p = Parda()
    red = p.redact(text)
    if reply is None:
        reply = TRANSFORMS[style](reply_for(red.text))
    restored = p.restore(reply)
    naive = _exact_restore(p, red.tokens, reply)
    return json.dumps(
        {
            "redacted": red.text,
            "found": [{"kind": s.kind, "start": s.start, "end": s.end} for s in red.spans],
            "tokens": red.tokens,
            "reply": reply,
            "restored": restored.text,
            "restored_count": restored.restored,
            "unknown": restored.unknown,
            "naive": naive,
            "leaks": len(p.leaks(red.text)),
            "values": [p.value_of(t) for t in red.tokens],
            "styles": list(TRANSFORMS),
        },
        ensure_ascii=False,
    )

"""Mechanical first pass of the Angular -> React port (temporary; deleted after the switch).

Rewrites imports and decorators in plain TypeScript files (services, pure
logic, specs) so they compile against ui/src/lib, and scopes component
stylesheets under a root class. Templates still need a hand-written JSX
port; this only does what is safe to do blindly.

    python scripts/port-angular.py src/app/core/fuzzy.ts ui/src/core/fuzzy.ts
    python scripts/port-angular.py css src/app/features/hud/hud.ts hud-card out.css [--append]
"""
import io
import os
import re
import sys

SIGNAL_API = {"signal", "computed", "effect", "untracked", "Signal", "WritableSignal"}


def port(text: str) -> str:
    def angular_import(match: re.Match[str]) -> str:
        type_only = match.group(1) is not None
        names = [n.strip() for n in match.group(2).split(",") if n.strip()]
        out = []
        signals = [n for n in names if n.replace("type ", "") in SIGNAL_API]
        if any(n.replace("type ", "") == "inject" for n in names):
            out.append("import { inject } from '@/lib/inject';")
        if signals:
            prefix = "import type" if type_only else "import"
            out.append(f"{prefix} {{ {', '.join(signals)} }} from '@/lib/signals';")
        return "\n".join(out)

    text = re.sub(r"import (type )?\{([^}]*)\} from '@angular/core';", angular_import, text)
    text = re.sub(r"^@Injectable\(\{[^}]*\}\)\n", "", text, flags=re.M)
    text = text.replace("'@core/", "'@/core/").replace("'@shared/", "'@/shared/")
    text = text.replace("'@features/", "'@/features/")
    return text


def component_styles(source: str) -> str:
    """The `styles` template literal of an Angular component file."""
    start = source.index("styles: `") + len("styles: `")
    return source[start : source.index("`,\n})", start)]


def scope_css(css: str, root: str) -> str:
    """Nests a component stylesheet under `.root`, so it cannot leak.

    `:host` becomes `&`; `::ng-deep` piercing is dropped (descendants are
    already in scope); `@keyframes` is hoisted, since it cannot nest.
    """
    css = re.sub(r":host\(([^()]*(?:\([^()]*\))?[^()]*)\)", r"&\1", css)
    css = css.replace(":host ::ng-deep ", "").replace("::ng-deep ", "")
    css = css.replace(":host", "&")
    # Both the umbra-button host and its inner .umbra-button are now one <button>.
    css = re.sub(r"(?<![-\w.])\.?umbra-button\b(?![-\w])", "[data-slot='button']", css)
    css = re.sub(r"\brl-kbd\b(?![-\w])", "[data-slot='kbd']", css)
    css = re.sub(r"\brl-icon\b(?![-\w])", "svg", css)
    keyframes: list[str] = []

    def hoist(match: re.Match[str]) -> str:
        keyframes.append(match.group(0).strip())
        return ""

    css = re.sub(r"@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}", hoist, css)
    lines = css.strip("\n").split("\n")
    indent = min((len(l) - len(l.lstrip()) for l in lines if l.strip()), default=0)
    body = "\n".join(("  " + l[indent:]) if l.strip() else "" for l in lines)
    hoisted = "".join(f"\n{k}\n" for k in keyframes)
    return f".{root} {{\n{body}\n}}\n{hoisted}"


if __name__ == "__main__":
    os.makedirs(os.path.dirname(sys.argv[-1] if sys.argv[-1] != "--append" else sys.argv[-2]) or ".", exist_ok=True)
    if sys.argv[1] == "css":
        source, root, target = sys.argv[2], sys.argv[3], sys.argv[4]
        text = io.open(source, encoding="utf-8").read()
        css = component_styles(text) if source.endswith(".ts") else text
        mode = "a" if "--append" in sys.argv else "w"
        with open(target, mode, encoding="utf-8", newline="\n") as f:
            f.write(("\n" if mode == "a" else "") + scope_css(css, root))
        sys.exit(0)
    source, target = sys.argv[1], sys.argv[2]
    with open(source, encoding="utf-8") as f:
        ported = port(f.read())
    with open(target, "w", encoding="utf-8", newline="\n") as f:
        f.write(ported)

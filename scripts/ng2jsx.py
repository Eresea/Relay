"""Draft JSX from an Angular component's template (temporary; deleted after the switch).

Reads an Angular component file and prints a draft .tsx: the template as JSX
over a state object `s` (every class member is read as `s.member`), plus the
class body ported to plain TypeScript. The draft is a starting point to edit
by hand, not a finished component: inputs, outputs, template refs and
directives are marked TODO.

    python scripts/ng2jsx.py src/app/features/vault/vault.ts > draft.tsx
"""
import io
import os
import re
import sys
from dataclasses import dataclass, field

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from importlib import import_module  # noqa: E402

port = import_module("port-angular").port  # type: ignore[attr-defined]

VOID = {"input", "br", "img", "hr", "meta", "link", "source", "col", "area", "wbr"}
COMPONENTS = {
    "rl-icon": "Icon",
    "rl-kbd": "Kbd",
    "umbra-button": "Button",
    "umbra-input": "Input",
    "umbra-switch": "Switch",
    "umbra-checkbox": "Checkbox",
    "umbra-textarea": "Textarea",
}
DROP_ATTRS = {"umbraButtonIcon", "ngModelOptions", "[ngModelOptions]"}
STATIC_NAMES = {
    "class": "className",
    "for": "htmlFor",
    "tabindex": "tabIndex",
    "readonly": "readOnly",
    "maxlength": "maxLength",
    "minlength": "minLength",
    "autocomplete": "autoComplete",
    "autofocus": "autoFocus",
    "spellcheck": "spellCheck",
    "contenteditable": "contentEditable",
    "colspan": "colSpan",
    "rowspan": "rowSpan",
    "enterkeyhint": "enterKeyHint",
    "inputmode": "inputMode",
    "novalidate": "noValidate",
    "datetime": "dateTime",
    "srcset": "srcSet",
    "crossorigin": "crossOrigin",
}
BOOLEAN_ATTRS = {"disabled", "hidden", "required", "checked", "multiple", "selected", "readonly",
                 "autofocus", "novalidate", "open"}
EVENTS = {
    "click": "onClick", "dblclick": "onDoubleClick", "input": "onChange", "change": "onChange",
    "keydown": "onKeyDown", "keyup": "onKeyUp", "focus": "onFocus", "blur": "onBlur",
    "focusin": "onFocus", "focusout": "onBlur", "submit": "onSubmit", "ngSubmit": "onSubmit",
    "mouseenter": "onMouseEnter", "mouseleave": "onMouseLeave", "mousemove": "onMouseMove",
    "mousedown": "onMouseDown", "mouseup": "onMouseUp", "pointerdown": "onPointerDown",
    "pointerup": "onPointerUp", "pointermove": "onPointerMove", "contextmenu": "onContextMenu",
    "dragstart": "onDragStart", "dragend": "onDragEnd", "dragover": "onDragOver",
    "dragenter": "onDragEnter", "dragleave": "onDragLeave", "drop": "onDrop", "scroll": "onScroll",
    "paste": "onPaste", "wheel": "onWheel", "toggle": "onToggle", "load": "onLoad",
}
KEYS = {"enter": "Enter", "escape": "Escape", "esc": "Escape", "space": " ", "tab": "Tab",
        "arrowdown": "ArrowDown", "arrowup": "ArrowUp", "backspace": "Backspace", "delete": "Delete"}


# ---------------------------------------------------------------- nodes
@dataclass
class Text:
    text: str


@dataclass
class Interp:
    expr: str


@dataclass
class Comment:
    text: str


@dataclass
class Element:
    tag: str
    attrs: list[tuple[str, str | None]]
    children: list = field(default_factory=list)


@dataclass
class If:
    branches: list  # [(cond, alias, children)]
    otherwise: list | None


@dataclass
class For:
    item: str
    expr: str
    track: str
    lets: list  # [(name, value)]
    children: list
    empty: list | None


@dataclass
class Switch:
    expr: str
    cases: list  # [(value, children)]
    default: list | None


@dataclass
class Let:
    name: str
    expr: str


# ---------------------------------------------------------------- parsing
def matching(text: str, pos: int, open_ch: str, close_ch: str) -> int:
    """Index of the bracket closing the one at `pos`, skipping strings."""
    depth, i, quote = 0, pos, None
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "'\"`":
            quote = ch
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    raise ValueError(f"unbalanced {open_ch} at {pos}: {text[pos:pos + 60]!r}")


def split_top(text: str, sep: str) -> list[str]:
    parts, depth, quote, start = [], 0, None, 0
    for i, ch in enumerate(text):
        if quote:
            if ch == quote:
                quote = None
            continue
        if ch in "'\"`":
            quote = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == sep and depth == 0:
            parts.append(text[start:i])
            start = i + 1
    parts.append(text[start:])
    return [p.strip() for p in parts]


class Parser:
    def __init__(self, text: str):
        self.t = text
        self.i = 0

    def skip_ws(self):
        while self.i < len(self.t) and self.t[self.i].isspace():
            self.i += 1

    def header(self) -> str:
        self.skip_ws()
        assert self.t[self.i] == "(", self.t[self.i:self.i + 40]
        end = matching(self.t, self.i, "(", ")")
        h = self.t[self.i + 1:end]
        self.i = end + 1
        return h.strip()

    def block(self) -> list:
        self.skip_ws()
        assert self.t[self.i] == "{", self.t[self.i:self.i + 40]
        self.i += 1
        nodes = self.nodes(in_block=True)
        assert self.t[self.i] == "}", self.t[self.i:self.i + 40]
        self.i += 1
        return nodes

    def peek_word(self, word: str) -> bool:
        save = self.i
        self.skip_ws()
        ok = self.t.startswith(word, self.i)
        self.i = save
        return ok

    def nodes(self, in_block=False, close_tag: str | None = None) -> list:
        out: list = []
        buf = ""
        while self.i < len(self.t):
            t, i = self.t, self.i
            if in_block and t[i] == "}":
                break
            if close_tag is not None and t.startswith("</", i):
                break
            if t.startswith("<!--", i):
                if buf:
                    out.append(Text(buf)); buf = ""
                end = t.index("-->", i)
                out.append(Comment(t[i + 4:end].strip()))
                self.i = end + 3
                continue
            if t[i] == "<" and re.match(r"<[a-zA-Z]", t[i:i + 2]):
                if buf:
                    out.append(Text(buf)); buf = ""
                out.append(self.element())
                continue
            if t.startswith("{{", i):
                if buf:
                    out.append(Text(buf)); buf = ""
                end = t.index("}}", i)
                out.append(Interp(t[i + 2:end].strip()))
                self.i = end + 2
                continue
            m = re.match(r"@(if|for|switch|let|defer)\b", t[i:])
            if m:
                if buf:
                    out.append(Text(buf)); buf = ""
                self.i += len(m.group(0))
                kind = m.group(1)
                out.append(getattr(self, "parse_" + kind)())
                continue
            buf += t[i]
            self.i += 1
        if buf:
            out.append(Text(buf))
        return [n for n in out if not (isinstance(n, Text) and not n.text.strip())] if False else out

    def parse_if(self):
        branches, otherwise = [], None
        h = self.header()
        cond, _, alias = h.partition(";")
        alias = alias.strip().removeprefix("as").strip() or None
        branches.append((cond.strip(), alias, self.block()))
        while True:
            save = self.i
            self.skip_ws()
            if self.t.startswith("@else if", self.i):
                self.i += len("@else if")
                h = self.header()
                cond, _, alias = h.partition(";")
                alias = alias.strip().removeprefix("as").strip() or None
                branches.append((cond.strip(), alias, self.block()))
            elif self.t.startswith("@else", self.i):
                self.i += len("@else")
                otherwise = self.block()
                break
            else:
                self.i = save
                break
        return If(branches, otherwise)

    def parse_for(self):
        parts = split_top(self.header(), ";")
        item, _, expr = parts[0].partition(" of ")
        track, lets = "$index", []
        for part in parts[1:]:
            if part.startswith("track "):
                track = part[len("track "):].strip()
            elif part.startswith("let "):
                for assignment in split_top(part[4:], ","):
                    name, _, value = assignment.partition("=")
                    lets.append((name.strip(), value.strip()))
        children = self.block()
        empty = None
        save = self.i
        self.skip_ws()
        if self.t.startswith("@empty", self.i):
            self.i += len("@empty")
            empty = self.block()
        else:
            self.i = save
        return For(item.strip(), expr.strip(), track, lets, children, empty)

    def parse_switch(self):
        expr = self.header()
        self.skip_ws()
        assert self.t[self.i] == "{"
        self.i += 1
        cases, default = [], None
        while True:
            self.skip_ws()
            if self.t.startswith("@case", self.i):
                self.i += len("@case")
                cases.append((self.header(), self.block()))
            elif self.t.startswith("@default", self.i):
                self.i += len("@default")
                default = self.block()
            else:
                break
        self.skip_ws()
        assert self.t[self.i] == "}"
        self.i += 1
        return Switch(expr, cases, default)

    def parse_let(self):
        depth, quote, end = 0, None, self.i
        while end < len(self.t):
            ch = self.t[end]
            if quote:
                quote = None if ch == quote else quote
            elif ch in "'\"`":
                quote = ch
            elif ch in "([{":
                depth += 1
            elif ch in ")]}":
                depth -= 1
            elif ch == ";" and depth == 0:
                break
            end += 1
        name, _, expr = self.t[self.i:end].partition("=")
        self.i = end + 1
        return Let(name.strip(), expr.strip())

    def parse_defer(self):
        self.skip_ws()
        if self.t[self.i] == "(":
            self.header()
        main = self.block()
        while True:
            save = self.i
            self.skip_ws()
            m = re.match(r"@(placeholder|loading|error)\b", self.t[self.i:])
            if not m:
                self.i = save
                break
            self.i += len(m.group(0))
            self.skip_ws()
            if self.t[self.i] == "(":
                self.header()
            self.block()
        return Element("FRAGMENT", [], main)

    def element(self) -> Element:
        m = re.match(r"<([a-zA-Z][\w-]*)", self.t[self.i:])
        tag = m.group(1)
        self.i += len(m.group(0))
        attrs = []
        while True:
            self.skip_ws()
            if self.t.startswith("/>", self.i):
                self.i += 2
                return Element(tag, attrs, [])
            if self.t[self.i] == ">":
                self.i += 1
                break
            am = re.match(r"[^\s=/>]+", self.t[self.i:])
            name = am.group(0)
            self.i += len(name)
            value = None
            if self.t[self.i] == "=":
                self.i += 1
                q = self.t[self.i]
                end = self.t.index(q, self.i + 1)
                value = self.t[self.i + 1:end]
                self.i = end + 1
            attrs.append((name, value))
        if tag.lower() in VOID:
            return Element(tag, attrs, [])
        children = self.nodes(close_tag=tag)
        close = re.match(r"</\s*([\w-]+)\s*>", self.t[self.i:])
        assert close, self.t[self.i:self.i + 40]
        self.i += len(close.group(0))
        return Element(tag, attrs, children)


# ---------------------------------------------------------------- expressions
JS_GLOBALS = {"Math", "Number", "String", "JSON", "Date", "Array", "Object", "Boolean",
              "undefined", "null", "true", "false", "this", "typeof", "instanceof", "new",
              "encodeURIComponent", "Infinity", "NaN", "isNaN", "parseInt", "parseFloat", "in"}
TOKEN = re.compile(r"""('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|\?\.|\S)""")


class Translator:
    def __init__(self, members: set[str]):
        self.members = members

    def expr(self, text: str, locals_: set[str]) -> str:
        """Prefixes component members with `s.`; leaves locals, globals and
        member accesses (`a.b`) and object keys (`{ b: 1 }`) alone."""
        text = re.sub(r"\$any\(\$event\.target\)", "$event.currentTarget", text)
        text = re.sub(r"\$any\(([^()]*)\)", r"\1", text)
        matches = list(TOKEN.finditer(text))
        result, pos = [], 0
        for index, match in enumerate(matches):
            tok = match.group(0)
            prev = matches[index - 1].group(0) if index > 0 else ""
            nxt = matches[index + 1].group(0) if index + 1 < len(matches) else ""
            result.append(text[pos:match.start()])
            pos = match.end()
            is_key = nxt == ":" and prev in ("{", ",")
            if (re.match(r"[A-Za-z_$]", tok) and prev not in (".", "?.") and not is_key
                    and tok in self.members and tok not in locals_):
                tok = "s." + tok
            result.append(tok)
        result.append(text[pos:])
        out = "".join(result)
        if re.search(r"(?<!\|)\|(?!\|)\s*[a-z]\w*", out):
            out += " /* TODO pipe */"
        return out

    def statements(self, text: str, locals_: set[str]) -> str:
        """An event handler body. Calls are `void`ed: Angular ignored what a
        template handler returned, and an async method's promise is not a
        value React should be handed."""
        parts = [p for p in split_top(text, ";") if p]
        translated = []
        for part in parts:
            js = self.expr(part, locals_)
            assignment = re.search(r"(?<![=!<>])=(?!=)", re.sub(r"=>", "", js))
            if not assignment and js.rstrip().endswith(")"):
                conditional = re.search(r"\?(?!\.)|&&|\|\|", js)
                js = f"void ({js})" if conditional else "void " + js
            translated.append(js)
        if len(translated) == 1 and not translated[0].startswith("void "):
            return translated[0]
        return "{ " + "; ".join(translated) + "; }"


# ---------------------------------------------------------------- emission
def camel(prop: str) -> str:
    if prop.startswith("--"):
        return f"'{prop}'"
    return re.sub(r"-([a-z])", lambda m: m.group(1).upper(), prop)


def component_name(tag: str) -> str:
    if tag in COMPONENTS:
        return COMPONENTS[tag]
    base = re.sub(r"^(rl|umbra)-", "", tag)
    return "".join(part.capitalize() for part in base.split("-"))


class Emitter:
    def __init__(self, members: set[str]):
        self.tx = Translator(members)
        self.uses: set[str] = set()

    def nodes(self, nodes: list, locals_: set[str]) -> str:
        out = []
        for index, node in enumerate(nodes):
            if isinstance(node, Let):
                rest = self.nodes(nodes[index + 1:], locals_ | {node.name})
                value = self.tx.expr(node.expr, locals_)
                out.append(f"{{(({node.name}) => (<>{rest}</>))({value})}}")
                break
            out.append(self.node(node, locals_))
        return "".join(out)

    def node(self, node, locals_: set[str]) -> str:
        if isinstance(node, Text):
            text = node.text.replace("{", "{'{'}").replace("}", "{'}'}")
            return text
        if isinstance(node, Interp):
            return "{" + self.tx.expr(node.expr, locals_) + "}"
        if isinstance(node, Comment):
            return "{/* " + node.text.replace("*/", "* /") + " */}"
        if isinstance(node, If):
            return "{" + self.if_chain(node.branches, node.otherwise, locals_) + "}"
        if isinstance(node, For):
            return self.for_loop(node, locals_)
        if isinstance(node, Switch):
            value = self.tx.expr(node.expr, locals_)
            chain = "null" if node.default is None else f"(<>{self.nodes(node.default, locals_)}</>)"
            for case, children in reversed(node.cases):
                chain = f"{value} === {self.tx.expr(case, locals_)} ? (<>{self.nodes(children, locals_)}</>) : {chain}"
            return "{" + chain + "}"
        if isinstance(node, Element):
            return self.element(node, locals_)
        raise TypeError(node)

    def if_chain(self, branches, otherwise, locals_) -> str:
        if not branches:
            return "null" if otherwise is None else f"(<>{self.nodes(otherwise, locals_)}</>)"
        (cond, alias, children), rest = branches[0], branches[1:]
        else_part = self.if_chain(rest, otherwise, locals_)
        value = self.tx.expr(cond, locals_)
        if alias:
            self.uses.add("when")
            body = self.nodes(children, locals_ | {alias})
            tail = "" if else_part == "null" else f", () => {else_part}"
            return f"when({value}, ({alias}) => (<>{body}</>){tail})"
        return f"{value} ? (<>{self.nodes(children, locals_)}</>) : {else_part}"

    def for_loop(self, node: For, locals_: set[str]) -> str:
        self.uses.add("Fragment")
        inner = locals_ | {node.item, "$index", "$first", "$last", "$count", "$even", "$odd"}
        inner |= {name for name, _ in node.lets}
        body = self.nodes(node.children, inner)
        consts = []
        derived = {"$first": "$index === 0", "$last": "$index === $array.length - 1",
                   "$count": "$array.length", "$even": "$index % 2 === 0", "$odd": "$index % 2 === 1"}
        used = body + node.track + " ".join(v for _, v in node.lets)
        for name, value in derived.items():
            if re.search(re.escape(name) + r"", used):
                consts.append(f"const {name} = {value};")
        for name, value in node.lets:
            consts.append(f"const {name} = {value};")
        key = self.tx.expr(node.track, inner)
        source = self.tx.expr(node.expr, locals_)
        array_param = ", $array" if "$array" in " ".join(consts) else ""
        uses_index = array_param or re.search(r"\$index\b", body + key + " ".join(consts))
        params = f"{node.item}, $index{array_param}" if uses_index else node.item
        mapped = (f"{source}.map(({params}) => {{ {' '.join(consts)} "
                  f"return (<Fragment key={{{key}}}>{body}</Fragment>); }})")
        if node.empty is not None:
            return "{" + f"{source}.length === 0 ? (<>{self.nodes(node.empty, locals_)}</>) : {mapped}" + "}"
        return "{" + mapped + "}"

    def element(self, el: Element, locals_: set[str]) -> str:
        if el.tag == "FRAGMENT" or el.tag == "ng-container":
            return f"<>{self.nodes(el.children, locals_)}</>"
        is_component = "-" in el.tag
        tag = component_name(el.tag) if is_component else el.tag
        if is_component:
            self.uses.add(tag)
        props: list[str] = []
        class_static, class_dyn, class_expr, style = None, [], None, []
        input_type = next((v for n, v in el.attrs if n == "type"), None)
        for name, value in el.attrs:
            v = value if value is not None else ""
            if name in DROP_ATTRS:
                continue
            if name.startswith("#"):
                props.append(f"ref={{/* TODO ref {name[1:]} */ undefined}}")
                continue
            if name == "class":
                class_static = v
            elif name.startswith("[class.") and name.endswith("]"):
                class_dyn.append((name[7:-1], self.tx.expr(v, locals_)))
            elif name == "[class]":
                class_expr = self.tx.expr(v, locals_)
            elif name == "style":
                for decl in filter(None, (d.strip() for d in v.split(";"))):
                    prop, _, val = decl.partition(":")
                    style.append((camel(prop.strip()), repr(val.strip())))
            elif name.startswith("[style.") and name.endswith("]"):
                prop = name[7:-1]
                unit = ""
                if prop.count(".") == 1 and not prop.startswith("--"):
                    prop, unit = prop.split(".")
                elif prop.startswith("--") and "." in prop:
                    prop, unit = prop.rsplit(".", 1)
                value_js = self.tx.expr(v, locals_)
                if unit:
                    unit = "%" if unit == "%" else unit
                    value_js = f"`${{{value_js}}}{unit}`"
                style.append((camel(prop), value_js))
            elif name.startswith("[attr.") and name.endswith("]"):
                attr = name[6:-1]
                attr = STATIC_NAMES.get(attr, attr)
                # Angular removes an attribute bound to null; React does the same for
                # undefined, which is also what React's attribute types accept.
                js = re.sub(r"(?<![\w.])null(?![\w])", "undefined", self.tx.expr(v, locals_))
                props.append(f"{attr}={{{js}}}")
            elif name == "(ngModelChange)":
                continue  # folded into the [(ngModel)] handler below
            elif name in ("[(ngModel)]", "[(value)]", "[(checked)]"):
                target = self.tx.expr(v, locals_)
                after = next((val for n, val in el.attrs if n == "(ngModelChange)"), None)
                then = f"; {self.tx.statements(after, locals_).strip('{} ')}" if after else ""
                if input_type == "checkbox" or name == "[(checked)]":
                    on = "onCheckedChange" if is_component else "onChange"
                    arg = "(value)" if is_component else "($event)"
                    val = "value" if is_component else "$event.currentTarget.checked"
                    props.append(f"checked={{{target}()}} {on}={{{arg} => {{ {target}.set({val}){then}; }}}}")
                elif is_component:
                    props.append(f"value={{{target}()}} onValueChange={{(value) => {{ {target}.set(value){then}; }}}}")
                else:
                    conv = "$event.currentTarget.valueAsNumber" if input_type == "number" else "$event.currentTarget.value"
                    props.append(f"value={{{target}()}} onChange={{($event) => {{ {target}.set({conv}){then}; }}}}")
            elif name.startswith("[") and name.endswith("]"):
                prop = name[1:-1]
                js = self.tx.expr(v, locals_)
                if prop == "innerHTML":
                    props.append(f"dangerouslySetInnerHTML={{{{ __html: {js} }}}}")
                elif prop == "ariaLabel":
                    props.append(f"aria-label={{{js}}}")
                else:
                    props.append(f"{STATIC_NAMES.get(prop.lower(), prop) if prop.lower() in STATIC_NAMES else prop}={{{js}}}")
            elif name.startswith("(") and name.endswith(")"):
                event = name[1:-1]
                key = None
                if "." in event:
                    event, key = event.split(".", 1)
                handler = self.tx.statements(v, locals_ | {"$event"})
                if key:
                    handler = f"{{ if ($event.key === '{KEYS.get(key, key)}') {{ {handler.strip('{} ')}; }} }}"
                if event == "ngSubmit":
                    handler = f"{{ $event.preventDefault(); {handler.strip('{} ')}; }}"
                if is_component and event not in EVENTS:
                    react = "on" + event[0].upper() + event[1:]
                elif is_component and event in ("click",):
                    react = "onClick"
                elif is_component:
                    react = "on" + event[0].upper() + event[1:]
                else:
                    react = EVENTS.get(event, "on" + event[0].upper() + event[1:])
                arg = "$event" if "$event" in handler else ""
                props.append(f"{react}={{({arg}) => {handler}}}")
            elif re.match(r"^[a-z][A-Za-z]*$", name) and value is None and name.startswith(("rl", "umbra")):
                props.append(f"data-todo-directive=\"{name}\"")
            else:
                attr = STATIC_NAMES.get(name, name)
                if value is None:
                    props.append(attr if name in BOOLEAN_ATTRS or is_component else f'{attr}=""')
                elif attr == "spellCheck":
                    props.append(f"spellCheck={{{v}}}")
                elif attr == "tabIndex":
                    props.append(f"tabIndex={{{v}}}")
                elif name in BOOLEAN_ATTRS:
                    props.append(attr)
                else:
                    props.append(f'{attr}="{v}"')
        if class_dyn or (class_expr and class_static):
            self.uses.add("cn")
            parts = []
            if class_static:
                parts.append(f"'{class_static}'")
            if class_expr:
                parts.append(class_expr)
            parts += [f"({cond}) && '{cls}'" for cls, cond in class_dyn]
            props.insert(0, f"className={{cn({', '.join(parts)})}}")
        elif class_expr:
            props.insert(0, f"className={{{class_expr}}}")
        elif class_static is not None:
            props.insert(0, f'className="{class_static}"')
        if style:
            body = ", ".join(f"{k}: {val}" for k, val in style)
            props.append(f"style={{{{ {body} }}}}")
        if is_component:
            renamed = []
            for prop in props:
                prop = re.sub(r"^ariaLabel=", "aria-label=", prop)
                prop = re.sub(r"^onTouch=", "onBlur=", prop)
                if tag in ("Switch", "Checkbox"):
                    prop = re.sub(r"^value=", "checked=", prop)
                    prop = re.sub(r"^onValueChange=", "onCheckedChange=", prop)
                    prop = re.sub(r"^\[label\]=|^label=", "label=", prop)
                renamed.append(prop)
            props = renamed
        open_tag = f"<{tag}{(' ' + ' '.join(props)) if props else ''}"
        if not el.children or all(isinstance(c, Text) and not c.text.strip() for c in el.children):
            if el.tag.lower() in VOID or is_component or not el.children:
                return open_tag + " />"
        return f"{open_tag}>{self.nodes(el.children, locals_)}</{tag}>"


# ---------------------------------------------------------------- driver
def class_members(source: str) -> set[str]:
    start = source.index("export class ")
    body = source[start:]
    names = set(re.findall(r"^  (?:(?:protected|private|public|readonly|static|async|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*[(=:<!?]", body, re.M))
    return names - {"constructor"}


IMPORTS = {
    "Button": "import { Button } from '@/components/ui/button';",
    "Input": "import { Input } from '@/components/ui/input';",
    "Switch": "import { Switch } from '@/components/ui/switch';",
    "Checkbox": "import { Checkbox } from '@/components/ui/checkbox';",
    "Textarea": "import { Textarea } from '@/components/ui/textarea';",
    "Icon": "import { Icon } from '@/shared/icon';",
    "Kbd": "import { Kbd } from '@/shared/kbd';",
    "AppPopover": "import { AppPopover, PopoverContent, PopoverTrigger } from '@/shared/app-popover';",
    "cn": "import { cn } from '@/lib/utils';",
    "when": "import { when } from '@/lib/jsx';",
}
SKIP_IMPORT = re.compile(
    r"from '@umbra/|from '@angular/|from '\./(icon|kbd|app-popover)'|from '@/shared/(icon|kbd|app-popover)'"
)


def convert(path: str):
    source = io.open(path, encoding="utf-8").read()
    template_start = source.index("template: `") + len("template: `")
    rest = source[template_start:]
    styles_marker = "`,\n  styles:"
    end_marker = "`,\n})"
    template_end = template_start + (rest.index(styles_marker) if styles_marker in rest else rest.index(end_marker))
    template = source[template_start:template_end]
    emitter = Emitter(class_members(source))
    jsx = emitter.nodes(Parser(template).nodes(), set())
    return source, emitter.uses, jsx


def main(path: str) -> None:
    source, uses, jsx = convert(path)
    print(f"// DRAFT from {path}; needs: {', '.join(sorted(uses))}")
    print(port(source[source.index("export class "):]))
    print()
    print("export function View({ s }: { s: unknown }) {")
    print("  useSignals();")
    print(f"  return (<>{jsx}</>);")
    print("}")


def assemble(path: str, name: str, root: str, target: str) -> None:
    """Writes a near-final .tsx: real imports, a `NameState` class, and the
    component reading it as `s`. Inputs, outputs, DestroyRef and template refs
    are left for a hand pass (search TODO)."""
    source, uses, jsx = convert(path)
    header = port(source[: source.index("@Component(")])
    header = re.sub(r"import \{[^}]*\} from '@angular/[^']+';\n", "", header)
    header = "\n".join(line for line in header.split("\n") if not SKIP_IMPORT.search(line))
    lines = []
    if "Fragment" in uses:
        lines.append("import { Fragment } from 'react';")
    for use in sorted(uses):
        if use in IMPORTS:
            lines.append(IMPORTS[use])
        elif use != "Fragment":
            lines.append(f"// TODO import {use}")
    lines.append("import { useController, useSignals } from '@/lib/signals';")
    body = port(source[source.index("export class "):])
    body = body.replace(f"export class {name} ", f"export class {name}State ", 1)
    body = re.sub(r"^(\s+)protected ", r"\1", body, flags=re.M)
    # Angular's DestroyRef and constructor effects: released when the screen unmounts.
    body = body.replace(
        "private readonly destroyRef = inject(DestroyRef);", "readonly destroyRef = new DestroyRef();"
    )
    if re.search(r"(?<![.\w])effect\(", body):
        body = re.sub(r"(?<![.\w])effect\(", "this.destroyRef.effect(", body)
        if "destroyRef = new DestroyRef()" not in body:
            body = re.sub(r"(export class \w+ \{\n)", r"\1  readonly destroyRef = new DestroyRef();\n", body, count=1)
    if "DestroyRef" in body:
        lines.append("import { DestroyRef } from '@/lib/signals';")
    if not re.search(r"(?<![.\w])effect\(", body):
        # Every effect now goes through destroyRef; drop the bare import.
        header = re.sub(r"(import \{[^}]*?)\beffect,\s*", r"\1", header)
        header = re.sub(r",\s*effect\b(?=[^}]*\} from '@/lib/signals')", "", header)
        header = re.sub(r"import \{\s*effect\s*\} from '@/lib/signals';\n?", "", header)
    css ="./" + target.replace("\\", "/").rsplit("/", 1)[-1].rsplit(".", 1)[0] + ".css"
    out = "\n".join(lines) + "\n" + header.strip() + f"\n\nimport '{css}';\n\n" + body.rstrip() + "\n\n"
    out += f"export function {name}() {{\n  useSignals();\n"
    out += f"  const s = useController(() => new {name}State());\n"
    out += f'  return (<div className="{root}">{jsx}</div>);\n}}\n'
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="\n") as f:
        f.write(out)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) > 2 and sys.argv[2] == "--assemble":
        # python scripts/ng2jsx.py <component.ts> --assemble <Name> <root-class> <out.tsx>
        assemble(sys.argv[1], sys.argv[3], sys.argv[4], sys.argv[5])
    else:
        main(sys.argv[1])

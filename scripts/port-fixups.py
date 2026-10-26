"""Hand fixes re-applied after regenerating a screen with ng2jsx --assemble
(temporary; deleted after the switch). Each entry is (old, new, count).

    python scripts/port-fixups.py vault
"""
import io
import sys

FIXUPS = {
    "gmail": [
        (
            "onChange={($event) => { s.newRuleKind.set($event.currentTarget.value); }}",
            "onChange={($event) => { s.newRuleKind.set($event.currentTarget.value as RuleKind['kind']); }}",
            1,
        ),
    ],
    "vault": [
        ("  private readonly masterPasswordField =\n    viewChild<ElementRef<HTMLInputElement>>('masterPasswordField');\n", "", 1),
        (
            "    afterRenderEffect(() => {\n      const status = this.status();\n      const field = this.masterPasswordField();\n"
            "      if ((status === 'locked' || status === 'missing') && field) field.nativeElement.focus();\n    });\n\n",
            "",
            1,
        ),
        (
            "  async uploadFiles(event: Event): Promise<void> {\n    const input = event.target as HTMLInputElement;",
            "  async uploadFiles(input: HTMLInputElement): Promise<void> {",
            1,
        ),
        (
            "export function Vault() {\n  useSignals();\n  const s = useController(() => new VaultState());",
            "export default function Vault() {\n  useSignals();\n  const s = useController(() => new VaultState());\n"
            "  const filePicker = useRef<HTMLInputElement>(null);",
            1,
        ),
        # The master password field only renders while locked or missing: focus it as it mounts.
        ("ref={/* TODO ref masterPasswordField */ undefined}", "ref={(field) => field?.focus()}", 2),
        (
            "ref={/* TODO ref filePicker */ undefined} type=\"file\" multiple onChange={($event) => { void s.uploadFiles($event); }}",
            "ref={filePicker} type=\"file\" multiple onChange={($event) => void s.uploadFiles($event.currentTarget)}",
            1,
        ),
        ("onClick={() => { void filePicker.click(); }}", "onClick={() => filePicker.current?.click()}", 1),
        ("import { Fragment } from 'react';", "import { Fragment, useRef } from 'react';", 1),
    ],
}

if __name__ == "__main__":
    name = sys.argv[1]
    path = sys.argv[2] if len(sys.argv) > 2 else f"ui/src/features/{name}/{name}.tsx"
    text = io.open(path, encoding="utf-8").read()
    for old, new, count in FIXUPS[name]:
        found = text.count(old)
        if found != count:
            sys.exit(f"{name}: expected {count} of {old[:70]!r}, found {found}")
        text = text.replace(old, new)
    io.open(path, "w", encoding="utf-8", newline="\n").write(text)

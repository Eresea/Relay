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
    "codex": [
        ("  private readonly sanitizer = inject(DomSanitizer);\n", "", 1),
        (
            "const safe = this.sanitizer.sanitize(SecurityContext.HTML, rendered) ?? '';",
            "// Agent-written Markdown becomes HTML: sanitize before it reaches the DOM.\n"
            "    const safe = DOMPurify.sanitize(rendered);",
            1,
        ),
        ("import { marked } from 'marked';", "import DOMPurify from 'dompurify';\nimport { marked } from 'marked';", 1),
    ],
    "mobile": [
        ("import { Settings } from '@/features/settings/settings';", "import Settings from '@/features/settings/settings';", 1),
        ("import { Vault } from '@/features/vault/vault';", "import Vault from '@/features/vault/vault';", 1),
        # Angular's afterRenderEffect: track the signals now, touch the DOM once
        # React has committed (the rail is inert until then, so focus would fail).
        # React commits in a microtask; a zero timeout runs after it.
        (
            "    afterRenderEffect(() => {\n"
            "      if (this.focusModuleHeading()) {\n"
            "        this.pageTitle.current?.focus();\n"
            "        this.focusModuleHeading.set(false);\n"
            "      } else if (this.railOpen()) {\n"
            "        this.moduleSearch.current?.focus();\n"
            "      }\n"
            "    });\n",
            "    this.destroyRef.effect(() => {\n"
            "      const focusHeading = this.focusModuleHeading();\n"
            "      const railOpen = this.railOpen();\n"
            "      const timer = setTimeout(() => {\n"
            "        if (focusHeading) {\n"
            "          this.pageTitle.current?.focus();\n"
            "          this.focusModuleHeading.set(false);\n"
            "        } else if (railOpen) {\n"
            "          this.moduleSearch.current?.focus();\n"
            "        }\n"
            "      });\n"
            "      return () => clearTimeout(timer);\n"
            "    });\n",
            1,
        ),
    ],
    "mobile-activedescendant": [
        ("s.activeModule() ? 'mobile-' + s.activeModule()!.id : undefined", "s.activeModule() ? `mobile-${s.activeModule()?.id}` : undefined", 1),
    ],
    "mobile-connections": [
        ("  const s = useController(() => new MobileConnectionsState());\n", "", 1),
        ("export class MobileConnectionsState {}\n", "", 1),
        ("import { useController, useSignals } from '@/lib/signals';", "import { useSignals } from '@/lib/signals';", 1),
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
            "export default function Vault() {\n  useSignals();\n  const s = useController(() => new VaultState());",
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

# Kite native helper

Build on Apple Silicon macOS with Xcode Command Line Tools using `./scripts/build-native.sh`. The arm64 macOS 13+ executable is `native/bin/kite-recorder`. It links only Apple frameworks and makes no network requests.

## Protocol

All stdout is newline-delimited JSON, flushed per message. Default mode waits without installing observers. Send `{"command":"start"}` on stdin to install nonintercepting global AppKit mouse and key monitors and foreground-app notifications. Send `{"command":"stop"}` or close stdin to remove observers and exit. Repeated start is harmless. Unknown or malformed commands emit errors.

Events contain `id` (UUID), `timestamp` (ISO 8601), `kind` (`app`, `click`, `shortcut`, `error`, `status`), `app`, `bundleId`, `title`, and `detail`. Click and point-status events also contain `x`/`y`, in global Quartz logical screen coordinates, with origin at the main display's top-left. Other displays can have negative coordinates. Lifecycle/error events can have empty application fields. The caller should retain only the events it needs and impose its own recording duration/storage limits.

Commands that execute once and exit:

- `--permissions`: prints `{"accessibility":boolean,"screenCapture":boolean}` without requesting permission.
- `--request-accessibility`: opens the system permission prompt where supported and returns current permission state. Approval can require a later Settings action/restart.
- `--request-screen`: explicitly asks for Screen Recording permission and returns current permission state.
- `--open-app com.example.App`: validates a reverse-domain bundle identifier and opens the installed app through NSWorkspace, without a shell. It emits a status or error and exits.
- `--point x y`: validates finite Quartz coordinates against connected screens and displays a noninteractive red ring for 1.2 seconds. Does not activate, click, or type in the target app.
- `--open-url com.example.App https://example.com/`: checks the bundle identifier as `--open-app` does, and requires an https address with a host. It opens the page in that app through NSWorkspace, without a shell, and emits `Web page opened` or an error.
- `--click x y left|right clicks`: checks the point as `--point` does, and requires 1 to 3 clicks. It needs Accessibility, checked with `AXIsProcessTrusted()` and `CGPreflightPostEventAccess()`, neither of which prompts. It shows the `--point` ring for 0.4 seconds, moves the pointer there, and sends the click; 2 or 3 clicks go as one double or triple click. The ring stays 0.3 seconds more, and the command emits `Click sent`. Killed during the first 0.4 seconds, it sends nothing.
- `--scroll x y up|down|left|right notches`: the same checks and ring as `--click`. It moves the pointer to the point and sends 1 to 10 line-unit wheel events of 3 lines each, then emits `Scroll sent`.
- `--type`: reads up to 4096 bytes of UTF-8 text from stdin, never from argv, which other processes can read. The text may not contain control characters or line breaks. It needs Accessibility, and refuses while OpenMuse (the helper's parent process) is the frontmost app, or while the focused element or one of its eight nearest ancestors is a secure text field. It sends one key event pair per character, carrying the character, so the keyboard layout doesn't matter, and emits `Text typed`.
- `--keys key [modifier ...]`: one key name from the fixed list (US ANSI key positions) and up to four different modifiers (`command`, `shift`, `option`, `control`). It needs Accessibility and refuses while OpenMuse is the frontmost app. It sends one key press with exactly those modifier flags, and no separate modifier key events, then emits `Keys pressed`.

## Privacy and limitations

Accessibility permission is required to start; denial emits an error and installs no observers. A revoked permission stops observation on the next observed event. Screen Recording is reported/requestable separately but is not needed by this helper; the helper captures no screenshots. Any screenshot integration must separately check permission.

Keyboard events include only Command/Control/Option combinations, represented by physical `KeyCode(n)` labels; ordinary typing, character strings, and repeated key-downs are omitted. Accessibility reads are limited to role, title, description, focused window/element, parent, and subrole. AXValue, selected text, and document contents are never read. Recognized secure text fields (including up to eight ancestors) redact context and suppress shortcuts. Secure fields that an application fails to identify cannot be reliably classified. Other window/control titles and descriptions may contain sensitive information and should be treated as private session data.

The helper skips its own process, its direct parent, apps named Kite/Kite Sprite/Electron, and known Kite bundle identifiers. Global monitors do not observe the helper itself. Some controls offer no accessible labels; such clicks still include their position and button. AX messaging is limited to 0.3 seconds per application/system request, though resolving multiple ancestors can take longer. Monitor installation success cannot guarantee delivery where macOS input permissions, Secure Event Input, or application behavior blocks events. Application activation is recorded, not every title change. The input commands post synthetic events. The main process runs them only for an agent run the user has given control of the Mac for that task; the helper itself doesn't know about grants. macOS attributes the Accessibility permission to the app responsible for the helper: OpenMuse Desktop when it was opened from Finder or the Dock, or the terminal that ran `npm run dev`.

A shipped signed app should bundle/sign the helper with a stable identity so macOS permission grants remain predictable across rebuilds. The development build is unsigned.

## Verification

Compile and run `native/bin/kite-recorder --permissions` for a read-only smoke test. Protocol tests may send malformed commands, stop, or EOF without start. Interactive recording and permission requests should only be tested during an explicitly authorized user session.

The input commands (`--click`, `--scroll`, `--type`, `--keys`) post real events to whatever is on screen, and `--open-url` opens a real page. Run them with valid arguments only in an explicitly authorized live session. Their argument checks run before any permission check or event, so malformed arguments can be tested safely.

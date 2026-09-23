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

## Privacy and limitations

Accessibility permission is required to start; denial emits an error and installs no observers. A revoked permission stops observation on the next observed event. Screen Recording is reported/requestable separately but is not needed by this helper; the helper captures no screenshots. Any screenshot integration must separately check permission.

Keyboard events include only Command/Control/Option combinations, represented by physical `KeyCode(n)` labels; ordinary typing, character strings, and repeated key-downs are omitted. Accessibility reads are limited to role, title, description, focused window/element, parent, and subrole. AXValue, selected text, and document contents are never read. Recognized secure text fields (including up to eight ancestors) redact context and suppress shortcuts. Secure fields that an application fails to identify cannot be reliably classified. Other window/control titles and descriptions may contain sensitive information and should be treated as private session data.

The helper skips its own process, its direct parent, apps named Kite/Kite Sprite/Electron, and known Kite bundle identifiers. Global monitors do not observe the helper itself. Some controls offer no accessible labels; such clicks still include their position and button. AX messaging is limited to 0.3 seconds per application/system request, though resolving multiple ancestors can take longer. Monitor installation success cannot guarantee delivery where macOS input permissions, Secure Event Input, or application behavior blocks events. Application activation is recorded, not every title change. This is an observation/pointing helper, not a general automation executor.

A shipped signed app should bundle/sign the helper with a stable identity so macOS permission grants remain predictable across rebuilds. The development build is unsigned.

## Verification

Compile and run `native/bin/kite-recorder --permissions` for a read-only smoke test. Protocol tests may send malformed commands, stop, or EOF without start. Interactive recording and permission requests should only be tested during an explicitly authorized user session.

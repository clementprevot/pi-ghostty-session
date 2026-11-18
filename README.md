# @clementprevot/pi-ghostty-session

A [Pi](https://pi.dev) extension that opens a new pi session in a Ghostty split, tab, or window on macOS. The session starts in the folder you pick, runs the prompt you give it, and stays a normal interactive session: you switch to it and carry on.

Use it when you want the agent to set up a session for you to join, for example a parallel task in a fresh worktree.

## Install

```bash
pi install npm:@clementprevot/pi-ghostty-session
```

Updates ship with `pi update --extensions`. The extension applies to your next session (quit and relaunch, or run `/reload`).

Requirements: macOS, Ghostty 1.3 or later (AppleScript support), and pi running inside Ghostty.

## Usage

The agent calls the `open_session` tool:

```json
{
  "surface": "split-down",
  "cwd": "~/worktrees/my-repo/fix-login",
  "prompt": "Fix the login redirect bug described in TICKET-123, then run the tests.",
  "model": "anthropic/claude-sonnet-4-5",
  "name": "fix-login"
}
```

- `surface`: `split-right`, `split-down`, `split-left`, `split-up` (a split of the pane that runs the current session), `tab` (a new tab in its window), or `window`.
- `cwd` (optional): folder to start in, absolute, relative to the working directory, or starting with `~/`. Defaults to the working directory.
- `prompt` (optional): the first message of the new session. Without it, pi opens idle.
- `model` (optional): passed to `pi --model`, so `provider/id` and a `:<thinking>` suffix work.
- `name` (optional): the session display name, passed to `pi --name`.

You can open one yourself with `/open-session <surface> [prompt]`, for example `/open-session split-right review the open TODOs`.

To have your agent use it, add a line like this one to your instructions: "When I ask for a new session I can join, open it with `open_session`."

## How it works

1. The tool resolves the folder and checks that it exists.
2. If there is a prompt, it writes it to a private file (mode 600) in `pi-ghostty-session/` under the system temp directory.
3. It runs one AppleScript through `osascript`. The script asks Ghostty for a new surface and types `pi [--model ...] [--name ...] -- "$(cat <prompt file>)"` into it. Every value reaches the script as an argument, never as script source.
4. For a split or a tab, the script finds the terminal of the current session by its TTY. The new surface lands next to this session even when another pane has the focus. If the script cannot find that terminal (inside tmux, for example), it uses the focused terminal of the front window and says so. With no Ghostty window open, it opens a new window.

The command runs in a fresh shell, so your PATH and shell setup apply, and the shell stays open when you quit pi.

## Limits

- macOS and Ghostty only. Elsewhere the tool reports an error.
- macOS may ask once whether your terminal may control Ghostty. If you declined, allow it in System Settings, Privacy & Security, Automation.
- The prompt files stay in the temp directory, which macOS cleans up on its own.

## Privacy and data

The extension writes the prompts you send to the temp directory and talks to Ghostty through AppleScript. It makes no network calls and collects no data.

## Local development

```bash
npm install
npm test
npm run typecheck
```

To try the extension in a live session without installing it:

```bash
pi -e /path/to/this/repo
```

## License

[MIT](LICENSE)

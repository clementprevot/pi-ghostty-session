import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const SURFACES = ["split-right", "split-down", "split-left", "split-up", "tab", "window"] as const;
export type Surface = (typeof SURFACES)[number];

export type SessionRequest = {
	surface: Surface;
	cwd?: string;
	prompt?: string;
	model?: string;
	name?: string;
};

type Exec = Pick<ExtensionAPI, "exec">["exec"];
type Env = Record<string, string | undefined>;

const SURFACE_LABELS: Record<Surface, string> = {
	"split-right": "a split to the right of this session",
	"split-down": "a split below this session",
	"split-left": "a split to the left of this session",
	"split-up": "a split above this session",
	tab: "a new tab of this session's window",
	window: "a new window",
};

// The script receives every value through argv, so nothing user-provided is ever spliced into AppleScript source.
export const GHOSTTY_SCRIPT = `on run argv
	set {surfaceKind, workingDirectory, startInput, ownTty} to argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to workingDirectory
		set initial input of cfg to startInput
		if surfaceKind is "window" or (count of windows) is 0 then
			new window with configuration cfg
			return "window"
		end if
		set targetWindow to missing value
		set targetTerminal to missing value
		repeat with w in windows
			repeat with t in terminals of w
				if tty of t is ownTty then
					set targetWindow to contents of w
					set targetTerminal to contents of t
					exit repeat
				end if
			end repeat
			if targetTerminal is not missing value then exit repeat
		end repeat
		set located to "own"
		if targetTerminal is missing value then
			set located to "front"
			set targetWindow to front window
			set targetTerminal to focused terminal of selected tab of targetWindow
		end if
		if surfaceKind is "tab" then
			new tab in targetWindow with configuration cfg
		else if surfaceKind is "split-right" then
			split targetTerminal direction right with configuration cfg
		else if surfaceKind is "split-down" then
			split targetTerminal direction down with configuration cfg
		else if surfaceKind is "split-left" then
			split targetTerminal direction left with configuration cfg
		else if surfaceKind is "split-up" then
			split targetTerminal direction up with configuration cfg
		else
			error "Unknown surface: " & surfaceKind
		end if
		return located
	end tell
end run`;

export function isSurface(value: string): value is Surface {
	return (SURFACES as readonly string[]).includes(value);
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildPiCommand(options: { promptFile?: string; model?: string; name?: string }): string {
	const parts = ["pi"];
	if (options.model) {
		parts.push("--model", shellQuote(options.model));
	}
	if (options.name) {
		parts.push("--name", shellQuote(options.name));
	}
	// The prompt goes through a file so its quotes, newlines and length never reach the shell input line. It follows no
	// "--": Node 26.13.1 kills itself when "--" precedes an argument that reaches PATH_MAX once joined to the cwd.
	if (options.promptFile) {
		parts.push(`"$(command cat ${shellQuote(options.promptFile)})"`);
	}

	return parts.join(" ");
}

export function resolveDirectory(input: string | undefined, cwd: string, home = homedir()): string {
	const path = input?.trim();
	if (!path) {
		return cwd;
	}
	if (path === "~") {
		return home;
	}
	if (path.startsWith("~/")) {
		return resolve(home, path.slice(2));
	}

	return resolve(cwd, path);
}

export function isGhosttyOnMac(env: Env = process.env, platform: string = process.platform): boolean {
	return platform === "darwin" && (env.TERM_PROGRAM === "ghostty" || Boolean(env.GHOSTTY_RESOURCES_DIR));
}

export function writePromptFile(prompt: string, dir = join(tmpdir(), "pi-ghostty-session")): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, `${randomUUID()}.md`);
	// Without "--", pi would read a leading "-" as an option and a leading "@" as a file to attach.
	writeFileSync(file, /^[-@]/.test(prompt) ? `\n${prompt}` : prompt, { mode: 0o600 });

	return file;
}

async function ownTty(exec: Exec): Promise<string> {
	const result = await exec("ps", ["-o", "tty=", "-p", String(process.pid)], { timeout: 5000 });
	const tty = result.stdout.trim();
	const hasTty = result.code === 0 && tty !== "" && !tty.startsWith("?");

	return hasTty ? `/dev/${tty}` : "";
}

function scriptError(result: { stderr: string; code: number }): Error {
	const reason = result.stderr.trim() || `osascript exited with code ${result.code}`;
	if (reason.includes("-1743")) {
		return new Error(
			"macOS blocked the AppleScript call to Ghostty. Allow it in System Settings > Privacy & Security > Automation, then retry.",
		);
	}

	return new Error(`Ghostty could not open the session: ${reason}`);
}

function describeOpened(surface: Surface, located: string, directory: string, hasPrompt: boolean): string {
	const isWindowFallback = located === "window" && surface !== "window";
	const where = isWindowFallback ? "a new window, since no Ghostty window was open" : SURFACE_LABELS[surface];
	const lines = [`Opened a new pi session in ${where}, in ${directory}, ${hasPrompt ? "started with the prompt" : "with no prompt"}.`];
	if (located === "front") {
		lines.push("This session's own Ghostty terminal was not found, so the new session opened next to the focused terminal of the front window.");
	}

	return lines.join(" ");
}

/** Throws errors whose message is shown as-is to the model or the user. */
export async function openSession(
	exec: Exec,
	request: SessionRequest,
	cwd: string,
	options: { env?: Env; platform?: string; signal?: AbortSignal; promptDir?: string } = {},
): Promise<string> {
	if (!isGhosttyOnMac(options.env, options.platform)) {
		throw new Error("open_session needs pi running inside Ghostty on macOS.");
	}
	if (!isSurface(request.surface)) {
		throw new Error(`Unknown surface "${request.surface}". Use one of: ${SURFACES.join(", ")}.`);
	}
	const directory = resolveDirectory(request.cwd, cwd);
	if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`${directory} is not a directory.`);
	}

	const prompt = request.prompt?.trim();
	const command = buildPiCommand({
		promptFile: prompt ? writePromptFile(prompt, options.promptDir) : undefined,
		model: request.model?.trim(),
		name: request.name?.trim(),
	});
	const result = await exec(
		"osascript",
		["-e", GHOSTTY_SCRIPT, request.surface, directory, `${command}\n`, await ownTty(exec)],
		{ signal: options.signal, timeout: 15_000 },
	);
	if (result.code !== 0) {
		throw scriptError(result);
	}

	return describeOpened(request.surface, result.stdout.trim(), directory, Boolean(prompt));
}

export function parseCommandArgs(args: string): SessionRequest | undefined {
	const surface = args.trim().split(/\s+/)[0] ?? "";
	if (!isSurface(surface)) {
		return undefined;
	}
	const prompt = args.trim().slice(surface.length).trim();

	return prompt ? { surface, prompt } : { surface };
}

export default function ghosttySessionExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "open_session",
		label: "Open session",
		description:
			"Open a new interactive pi session in a Ghostty split, tab, or window on macOS, in the folder you choose and started with your prompt. The user can then join and drive it directly.",
		promptSnippet: "Open a new interactive pi session for the user in a Ghostty split, tab, or window",
		promptGuidelines: [
			"Use open_session when the user asks for a new session or agent they can join, not for a background subagent.",
			"Write the open_session prompt so it stands alone: the new session knows nothing about this conversation.",
		],
		parameters: Type.Object({
			surface: Type.Unsafe<Surface>({
				type: "string",
				enum: [...SURFACES],
				description: "Where to open it: a split of this session's pane in a direction, a new tab in this window, or a new window",
			}),
			cwd: Type.Optional(
				Type.String({ description: "Folder to start in: absolute, relative to the working directory, or starting with ~/. Defaults to the working directory" }),
			),
			prompt: Type.Optional(Type.String({ description: "First message the new session runs. Omit to open an idle session" })),
			model: Type.Optional(Type.String({ description: "Model for the new session, as provider/id with an optional :<thinking> suffix" })),
			name: Type.Optional(Type.String({ description: "Display name of the new session" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const text = await openSession(pi.exec.bind(pi), params, ctx.cwd, { signal });

			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerCommand("open-session", {
		description: `Open a new pi session in Ghostty: /open-session <${SURFACES.join("|")}> [prompt]`,
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix)) {
				return null;
			}
			const items = SURFACES.filter((surface) => surface.startsWith(prefix)).map((surface) => ({ value: surface, label: surface }));

			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const request = parseCommandArgs(args);
			if (!request) {
				ctx.ui.notify(`Usage: /open-session <${SURFACES.join("|")}> [prompt]`, "error");
				return;
			}
			try {
				ctx.ui.notify(await openSession(pi.exec.bind(pi), request, ctx.cwd), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const SURFACES = ["split-right", "split-down", "split-left", "split-up", "tab", "window"] as const;
export type Surface = (typeof SURFACES)[number];

export const PLACEMENTS = ["tab", "window"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export type SessionSpec = {
	cwd?: string;
	prompt?: string;
	model?: string;
	name?: string;
};

export type SessionRequest = SessionSpec & { surface: Surface };

export type TabRequest = {
	title?: string;
	tab?: string;
	sessions: SessionSpec[];
};

export type BatchRequest = {
	placement?: Placement;
	tabs: TabRequest[];
};

export type OpenedTab = {
	id: string;
	title?: string;
	sessions: { name?: string; directory: string; terminal: string }[];
};

type Exec = Pick<ExtensionAPI, "exec">["exec"];
type Env = Record<string, string | undefined>;
type ScriptOptions = { env?: Env; platform?: string; signal?: AbortSignal; promptDir?: string };
type PreparedSession = { directory: string; input: string; hasPrompt: boolean; name?: string };

const SURFACE_LABELS: Record<Surface, string> = {
	"split-right": "a split to the right of this session",
	"split-down": "a split below this session",
	"split-left": "a split to the left of this session",
	"split-up": "a split above this session",
	tab: "a new tab of this session's window",
	window: "a new window",
};

const SCRIPT_HANDLERS = `on findOwn(ownTty)
	tell application "Ghostty"
		repeat with w in windows
			repeat with t in terminals of w
				if tty of t is ownTty then return {contents of w, contents of t}
			end repeat
		end repeat
	end tell
	return missing value
end findOwn

on findTab(tabId)
	tell application "Ghostty"
		repeat with w in windows
			repeat with t in tabs of w
				if id of t is tabId then return contents of t
			end repeat
		end repeat
	end tell
	error "No Ghostty tab has the id " & tabId & "."
end findTab

on tabIdOf(terminalId)
	tell application "Ghostty"
		repeat with w in windows
			repeat with t in tabs of w
				repeat with s in terminals of t
					if id of s is terminalId then return id of t
				end repeat
			end repeat
		end repeat
	end tell
	return ""
end tabIdOf

-- Ghostty lists the terminals of a tab column by column, so the panes stay in two columns filled row by row: the second
-- pane goes right of the first, and each later one goes under the bottom pane of the shorter column.
on addToGrid(targetTab, cfg)
	tell application "Ghostty"
		set existing to terminals of targetTab
		set k to count of existing
		if k is 1 then return split (item 1 of existing) direction right with configuration cfg
		if k mod 2 is 0 then return split (item (k div 2) of existing) direction down with configuration cfg
		return split (item k of existing) direction down with configuration cfg
	end tell
end addToGrid
`;

// The scripts receive every value through argv, so nothing user-provided is ever spliced into AppleScript source.
export const GHOSTTY_SCRIPT = `${SCRIPT_HANDLERS}
on run argv
	set sep to character id 9
	set {surfaceKind, workingDirectory, startInput, ownTty} to argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to workingDirectory
		set initial input of cfg to startInput
		if surfaceKind is "window" or (count of windows) is 0 then
			set newWindow to new window with configuration cfg
			set newTab to selected tab of newWindow
			return "window" & sep & (id of newTab) & sep & (id of (focused terminal of newTab))
		end if
		set located to "own"
		set ownPair to my findOwn(ownTty)
		if ownPair is missing value then
			set located to "front"
			set targetWindow to front window
			set targetTerminal to focused terminal of selected tab of targetWindow
		else
			set {targetWindow, targetTerminal} to ownPair
		end if
		if surfaceKind is "tab" then
			set newTab to new tab in targetWindow with configuration cfg
			return located & sep & (id of newTab) & sep & (id of (focused terminal of newTab))
		else if surfaceKind is "split-right" then
			set newTerminal to split targetTerminal direction right with configuration cfg
		else if surfaceKind is "split-down" then
			set newTerminal to split targetTerminal direction down with configuration cfg
		else if surfaceKind is "split-left" then
			set newTerminal to split targetTerminal direction left with configuration cfg
		else if surfaceKind is "split-up" then
			set newTerminal to split targetTerminal direction up with configuration cfg
		else
			error "Unknown surface: " & surfaceKind
		end if
		return located & sep & (my tabIdOf(id of newTerminal)) & sep & (id of newTerminal)
	end tell
end run`;

export const GHOSTTY_BATCH_SCRIPT = `${SCRIPT_HANDLERS}
on run argv
	set sep to character id 9
	set placement to item 1 of argv
	set ownTty to item 2 of argv
	set tabCount to (item 3 of argv) as integer
	set pos to 4
	tell application "Ghostty"
		set targetWindow to missing value
		set located to "window"
		if placement is "tab" then
			set ownPair to my findOwn(ownTty)
			if ownPair is not missing value then
				set targetWindow to item 1 of ownPair
				set located to "own"
			else if (count of windows) > 0 then
				set targetWindow to front window
				set located to "front"
			end if
		end if
		set out to "located" & sep & located & linefeed
		repeat tabCount times
			set tabTitle to item pos of argv
			set existingTabId to item (pos + 1) of argv
			set sessionCount to (item (pos + 2) of argv) as integer
			set pos to pos + 3
			set targetTab to missing value
			if existingTabId is not "" then set targetTab to my findTab(existingTabId)
			set terminalLines to ""
			repeat sessionCount times
				set cfg to new surface configuration
				set initial working directory of cfg to item pos of argv
				set initial input of cfg to item (pos + 1) of argv
				set pos to pos + 2
				if targetTab is missing value then
					if targetWindow is missing value then
						set targetWindow to new window with configuration cfg
						set targetTab to selected tab of targetWindow
					else
						set targetTab to new tab in targetWindow with configuration cfg
					end if
					set newTerminal to focused terminal of targetTab
				else
					set newTerminal to my addToGrid(targetTab, cfg)
				end if
				set terminalLines to terminalLines & "terminal" & sep & (id of newTerminal) & linefeed
			end repeat
			if tabTitle is not "" then set name override of targetTab to tabTitle
			if (count of terminals of targetTab) > 1 then perform action "equalize_splits" on newTerminal
			set out to out & "tab" & sep & (id of targetTab) & linefeed & terminalLines
		end repeat
		return out
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

export function parseBatchOutput(stdout: string): { located: string; tabs: { id: string; terminals: string[] }[] } {
	let located = "";
	const tabs: { id: string; terminals: string[] }[] = [];
	for (const line of stdout.split("\n")) {
		const [kind, value = ""] = line.trim().split("\t");
		if (kind === "located") {
			located = value;
		} else if (kind === "tab") {
			tabs.push({ id: value, terminals: [] });
		} else if (kind === "terminal") {
			tabs.at(-1)?.terminals.push(value);
		}
	}

	return { located, tabs };
}

function assertGhostty(tool: string, options: ScriptOptions): void {
	if (!isGhosttyOnMac(options.env, options.platform)) {
		throw new Error(`${tool} needs pi running inside Ghostty on macOS.`);
	}
}

function prepareSession(spec: SessionSpec, cwd: string, promptDir?: string): PreparedSession {
	const directory = resolveDirectory(spec.cwd, cwd);
	if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`${directory} is not a directory.`);
	}
	const prompt = spec.prompt?.trim();
	const name = spec.name?.trim() || undefined;
	const command = buildPiCommand({ promptFile: prompt ? writePromptFile(prompt, promptDir) : undefined, model: spec.model?.trim(), name });

	return { directory, input: `${command}\n`, hasPrompt: Boolean(prompt), name };
}

async function ownTty(exec: Exec): Promise<string> {
	const result = await exec("ps", ["-o", "tty=", "-p", String(process.pid)], { timeout: 5000 });
	const tty = result.stdout.trim();
	const hasTty = result.code === 0 && tty !== "" && !tty.startsWith("?");

	return hasTty ? `/dev/${tty}` : "";
}

async function runScript(exec: Exec, script: string, args: string[], signal: AbortSignal | undefined, timeout: number): Promise<string> {
	const result = await exec("osascript", ["-e", script, ...args], { signal, timeout });
	if (result.code === 0) {
		return result.stdout;
	}
	const reason = result.stderr.trim() || `osascript exited with code ${result.code}`;
	if (reason.includes("-1743")) {
		throw new Error(
			"macOS blocked the AppleScript call to Ghostty. Allow it in System Settings > Privacy & Security > Automation, then retry.",
		);
	}

	throw new Error(`Ghostty could not open the session: ${reason}`);
}

function describeOpened(surface: Surface, stdout: string, directory: string, hasPrompt: boolean): string {
	const [located, tabId, terminalId] = stdout.trim().split("\t");
	const isWindowFallback = located === "window" && surface !== "window";
	const where = isWindowFallback ? "a new window, since no Ghostty window was open" : SURFACE_LABELS[surface];
	const lines = [`Opened a new pi session in ${where}, in ${directory}, ${hasPrompt ? "started with the prompt" : "with no prompt"}.`];
	if (located === "front") {
		lines.push("This session's own Ghostty terminal was not found, so the new session opened next to the focused terminal of the front window.");
	}
	if (tabId && terminalId) {
		lines.push(`Its tab id is ${tabId} and its terminal id is ${terminalId}; pass the tab id to open_sessions to add sessions to that tab.`);
	}

	return lines.join(" ");
}

function describeBatch(tabs: OpenedTab[], located: string, opensTabs: boolean): string {
	const count = tabs.reduce((total, tab) => total + tab.sessions.length, 0);
	const lines = [`Opened ${count} pi session${count === 1 ? "" : "s"}:`];
	for (const tab of tabs) {
		const sessions = tab.sessions.map((session) => `${session.name ?? "unnamed"} in ${session.directory} (terminal id ${session.terminal})`);
		lines.push(`- tab ${tab.title ? `"${tab.title}" ` : ""}(tab id ${tab.id}): ${sessions.join(", ")}`);
	}
	if (opensTabs && located === "front") {
		lines.push("This session's own Ghostty terminal was not found, so the new tabs opened in the front window.");
	}
	lines.push("Pass a tab id as `tab` to open_sessions to add sessions to that tab.");

	return lines.join("\n");
}

/** Throws errors whose message is shown as-is to the model or the user. */
export async function openSession(exec: Exec, request: SessionRequest, cwd: string, options: ScriptOptions = {}): Promise<string> {
	assertGhostty("open_session", options);
	if (!isSurface(request.surface)) {
		throw new Error(`Unknown surface "${request.surface}". Use one of: ${SURFACES.join(", ")}.`);
	}
	const session = prepareSession(request, cwd, options.promptDir);
	const stdout = await runScript(
		exec,
		GHOSTTY_SCRIPT,
		[request.surface, session.directory, session.input, await ownTty(exec)],
		options.signal,
		15_000,
	);

	return describeOpened(request.surface, stdout, session.directory, session.hasPrompt);
}

export async function openSessions(
	exec: Exec,
	request: BatchRequest,
	cwd: string,
	options: ScriptOptions = {},
): Promise<{ text: string; tabs: OpenedTab[] }> {
	assertGhostty("open_sessions", options);
	const placement = request.placement ?? "tab";
	if (!(PLACEMENTS as readonly string[]).includes(placement)) {
		throw new Error(`Unknown placement "${placement}". Use one of: ${PLACEMENTS.join(", ")}.`);
	}
	if (!request.tabs?.length) {
		throw new Error("open_sessions needs at least one tab.");
	}
	const groups = request.tabs.map((group, index) => {
		if (!group.sessions?.length) {
			throw new Error(`Tab ${index + 1} has no sessions.`);
		}

		return {
			title: group.title?.trim() ?? "",
			tab: group.tab?.trim() ?? "",
			sessions: group.sessions.map((session) => prepareSession(session, cwd, options.promptDir)),
		};
	});

	const args = [placement, await ownTty(exec), String(groups.length)];
	for (const group of groups) {
		args.push(group.title, group.tab, String(group.sessions.length));
		for (const session of group.sessions) {
			args.push(session.directory, session.input);
		}
	}
	const sessionCount = groups.reduce((total, group) => total + group.sessions.length, 0);
	const output = parseBatchOutput(await runScript(exec, GHOSTTY_BATCH_SCRIPT, args, options.signal, 10_000 + 5_000 * sessionCount));
	const tabs = groups.map((group, index) => ({
		id: output.tabs[index]?.id ?? "",
		title: group.title || undefined,
		sessions: group.sessions.map((session, position) => ({
			name: session.name,
			directory: session.directory,
			terminal: output.tabs[index]?.terminals[position] ?? "",
		})),
	}));

	return { text: describeBatch(tabs, output.located, groups.some((group) => !group.tab)), tabs };
}

export function parseCommandArgs(args: string): SessionRequest | undefined {
	const surface = args.trim().split(/\s+/)[0] ?? "";
	if (!isSurface(surface)) {
		return undefined;
	}
	const prompt = args.trim().slice(surface.length).trim();

	return prompt ? { surface, prompt } : { surface };
}

const SESSION_FIELDS = {
	cwd: Type.Optional(
		Type.String({ description: "Folder to start in: absolute, relative to the working directory, or starting with ~/. Defaults to the working directory" }),
	),
	prompt: Type.Optional(Type.String({ description: "First message the new session runs. Omit to open an idle session" })),
	model: Type.Optional(Type.String({ description: "Model for the new session, as provider/id with an optional :<thinking> suffix" })),
	name: Type.Optional(Type.String({ description: "Display name of the new session" })),
};

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
			...SESSION_FIELDS,
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const text = await openSession(pi.exec.bind(pi), params, ctx.cwd, { signal });

			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "open_sessions",
		label: "Open sessions",
		description:
			"Open several interactive pi sessions at once in Ghostty on macOS, grouped in tabs: each tab gets a title and holds one pane per session, laid out in two columns. Can also add sessions to a tab opened earlier, by its tab id.",
		promptSnippet: "Open several related pi sessions for the user at once, one Ghostty tab per topic and one pane per session",
		promptGuidelines: [
			"Use open_sessions instead of several open_session calls when the user asks for several related sessions at once: one tab per topic, titled after it, with one pane per session.",
			"To add sessions to a tab that open_session or open_sessions opened earlier, pass its tab id as `tab` in open_sessions.",
		],
		parameters: Type.Object({
			placement: Type.Optional(
				Type.Unsafe<Placement>({
					type: "string",
					enum: [...PLACEMENTS],
					description: "Where new tabs go: in this session's window (tab, the default) or in a new window",
				}),
			),
			tabs: Type.Array(
				Type.Object({
					title: Type.Optional(Type.String({ description: "Tab title, usually the topic. Also renames an existing tab" })),
					tab: Type.Optional(
						Type.String({ description: "Id of an existing tab, as returned by open_session or open_sessions, to add the sessions to it" }),
					),
					sessions: Type.Array(Type.Object(SESSION_FIELDS), { minItems: 1, description: "Sessions of this tab, one pane each" }),
				}),
				{ minItems: 1 },
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { text, tabs } = await openSessions(pi.exec.bind(pi), params, ctx.cwd, { signal });

			return { content: [{ type: "text", text }], details: { tabs } };
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

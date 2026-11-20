import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const SURFACES = ["split-right", "split-down", "split-left", "split-up", "tab", "window"] as const;
export type Surface = (typeof SURFACES)[number];

export const PLACEMENTS = ["tab", "window"] as const;
export type Placement = (typeof PLACEMENTS)[number];

export type SessionSpec = {
	session?: string;
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
	sessions: { name?: string; directory: string; terminal: string; resumed?: string }[];
};

type Exec = Pick<ExtensionAPI, "exec">["exec"];
type Env = Record<string, string | undefined>;
export type StoredSession = { id: string; path: string; cwd: string; name?: string };
export type LiveSession = { pid: number; tty: string };

type ScriptOptions = {
	env?: Env;
	platform?: string;
	signal?: AbortSignal;
	promptDir?: string;
	liveDir?: string;
	listSessions?: () => Promise<StoredSession[]>;
};
type PreparedSession = { directory: string; input: string; hasPrompt: boolean; name?: string; resumed?: StoredSession };

export const LIVE_DIR = join(tmpdir(), "pi-ghostty-session", "live");

const SURFACE_LABELS: Record<Surface, string> = {
	"split-right": "a split to the right of this session",
	"split-down": "a split below this session",
	"split-left": "a split to the left of this session",
	"split-up": "a split above this session",
	tab: "a new tab of this session's window",
	window: "a new window",
};

const SCRIPT_HANDLERS = `on findByTty(ttyPath)
	tell application "Ghostty"
		repeat with w in windows
			repeat with t in terminals of w
				if tty of t is ttyPath then return {contents of w, contents of t}
			end repeat
		end repeat
	end tell
	return missing value
end findByTty

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

on tabOf(terminalId)
	tell application "Ghostty"
		repeat with w in windows
			repeat with t in tabs of w
				repeat with s in terminals of t
					if id of s is terminalId then return contents of t
				end repeat
			end repeat
		end repeat
	end tell
	return missing value
end tabOf

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
		set ownPair to my findByTty(ownTty)
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
		return located & sep & (id of (my tabOf(id of newTerminal))) & sep & (id of newTerminal)
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
			set ownPair to my findByTty(ownTty)
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

export const GHOSTTY_FIND_SCRIPT = `${SCRIPT_HANDLERS}
on run argv
	set sep to character id 9
	set {targetTty, mode} to argv
	tell application "Ghostty"
		set hit to my findByTty(targetTty)
		if hit is missing value then return ""
		set targetTerminal to item 2 of hit
		if mode is "focus" then focus targetTerminal
		set targetTab to my tabOf(id of targetTerminal)
		return (id of targetTab) & sep & (name of targetTab)
	end tell
end run`;

export function isSurface(value: string): value is Surface {
	return (SURFACES as readonly string[]).includes(value);
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildPiCommand(options: { session?: string; promptFile?: string; model?: string; name?: string }): string {
	const parts = ["pi"];
	if (options.session) {
		parts.push("--session", shellQuote(options.session));
	}
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

export function readSessionHeader(path: string): { id: string; cwd: string } {
	let header: { type?: unknown; id?: unknown; cwd?: unknown } | undefined;
	try {
		const fd = openSync(path, "r");
		const buffer = Buffer.alloc(64 * 1024);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		closeSync(fd);
		header = JSON.parse(buffer.subarray(0, length).toString("utf8").split("\n")[0] ?? "");
	} catch {
		header = undefined;
	}
	if (header?.type !== "session" || typeof header.id !== "string") {
		throw new Error(`${path} is not a pi session file.`);
	}

	return { id: header.id, cwd: typeof header.cwd === "string" ? header.cwd : "" };
}

/** Resolves a session file path, or a full or partial session id, to the stored session it names. */
export async function resolveSession(ref: string, cwd: string, listSessions: () => Promise<StoredSession[]>): Promise<StoredSession> {
	const value = ref.trim();
	if (value.includes("/") || value.endsWith(".jsonl")) {
		const path = resolveDirectory(value, cwd);

		return { ...readSessionHeader(path), path };
	}
	const sessions = await listSessions();
	const exact = sessions.find((session) => session.id === value);
	const matches = exact ? [exact] : sessions.filter((session) => session.id.startsWith(value));
	if (matches.length === 0) {
		throw new Error(`No pi session matches "${value}".`);
	}
	if (matches.length > 1) {
		const listed = matches.slice(0, 5).map((session) => `${sessionLabel(session)} in ${session.cwd}`);
		throw new Error(`"${value}" matches ${matches.length} sessions (${listed.join("; ")}). Pass a longer id or the session file.`);
	}

	return matches[0]!;
}

function sessionLabel(session: { id: string; name?: string }): string {
	return session.name ? `"${session.name}" (${session.id})` : session.id;
}

function liveFile(dir: string, id: string): string | undefined {
	return /^[\w-]+$/.test(id) ? join(dir, `${id}.json`) : undefined;
}

export function registerLiveSession(dir: string, id: string, live: LiveSession): void {
	const file = liveFile(dir, id);
	if (file) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(file, JSON.stringify(live), { mode: 0o600 });
	}
}

function readLiveSession(dir: string, id: string): LiveSession | undefined {
	const file = liveFile(dir, id);
	try {
		const live = file ? JSON.parse(readFileSync(file, "utf8")) : undefined;

		return typeof live?.pid === "number" && typeof live?.tty === "string" ? live : undefined;
	} catch {
		return undefined;
	}
}

export function unregisterLiveSession(dir: string, id: string, pid: number): void {
	const file = liveFile(dir, id);
	if (file && readLiveSession(dir, id)?.pid === pid) {
		rmSync(file, { force: true });
	}
}

/** Returns the pi process that has the session open, when that process still runs pi on the recorded terminal. */
export async function findLiveSession(exec: Exec, dir: string, id: string): Promise<LiveSession | undefined> {
	const live = readLiveSession(dir, id);
	if (!live) {
		return undefined;
	}
	const result = await exec("ps", ["-o", "tty=,command=", "-p", String(live.pid)], { timeout: 5000 });
	const [tty = "", command = ""] = result.stdout.trim().split(/\s+/);
	const isSameProcess = result.code === 0 && `/dev/${tty}` === live.tty && /^pi\b/.test(command);

	return isSameProcess ? live : undefined;
}

async function prepareSession(spec: SessionSpec, cwd: string, options: ScriptOptions): Promise<PreparedSession> {
	const resumed = spec.session?.trim()
		? await resolveSession(spec.session, cwd, options.listSessions ?? (() => SessionManager.listAll()))
		: undefined;
	const sessionCwd = resumed?.cwd && statSync(resumed.cwd, { throwIfNoEntry: false })?.isDirectory() ? resumed.cwd : undefined;
	const directory = !spec.cwd?.trim() && sessionCwd ? sessionCwd : resolveDirectory(spec.cwd, cwd);
	if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`${directory} is not a directory.`);
	}
	const prompt = spec.prompt?.trim();
	const name = spec.name?.trim() || undefined;
	const command = buildPiCommand({
		// A file path, never an id: pi offers to fork an id it finds in another project, but opens a session file in place.
		session: resumed?.path,
		promptFile: prompt ? writePromptFile(prompt, options.promptDir) : undefined,
		model: spec.model?.trim(),
		name,
	});

	return { directory, input: `${command}\n`, hasPrompt: Boolean(prompt), name: name ?? resumed?.name, resumed };
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

function describeOpened(surface: Surface, stdout: string, session: PreparedSession): string {
	const [located, tabId, terminalId] = stdout.trim().split("\t");
	const isWindowFallback = located === "window" && surface !== "window";
	const where = isWindowFallback ? "a new window, since no Ghostty window was open" : SURFACE_LABELS[surface];
	const opened = session.resumed
		? `Resumed pi session ${sessionLabel(session.resumed)} in ${where}, in ${session.directory}, ${session.hasPrompt ? "with the prompt as its next message" : "with no new message"}.`
		: `Opened a new pi session in ${where}, in ${session.directory}, ${session.hasPrompt ? "started with the prompt" : "with no prompt"}.`;
	const lines = [opened];
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
		const sessions = tab.sessions.map((session) => {
			const label = session.resumed ? `${session.name ?? "unnamed"} (resumed session ${session.resumed})` : (session.name ?? "unnamed");

			return `${label} in ${session.directory} (terminal id ${session.terminal})`;
		});
		lines.push(`- tab ${tab.title ? `"${tab.title}" ` : ""}(tab id ${tab.id}): ${sessions.join(", ")}`);
	}
	if (opensTabs && located === "front") {
		lines.push("This session's own Ghostty terminal was not found, so the new tabs opened in the front window.");
	}
	lines.push("Pass a tab id as `tab` to open_sessions to add sessions to that tab.");

	return lines.join("\n");
}

function describeLive(session: StoredSession, live: LiveSession, stdout: string, focused: boolean): string {
	const [tabId, tabName] = stdout.trim().split("\t");
	const label = sessionLabel(session);
	if (!tabId) {
		return `Session ${label} is already open in pi process ${live.pid} on ${live.tty}, outside the Ghostty terminals this extension can see. Tell the user to switch to it there.`;
	}
	const tab = `the Ghostty tab "${tabName}" (tab id ${tabId})`;

	return focused
		? `Session ${label} is already open, so no new pane opened. Its pane, in ${tab}, now has the focus: tell the user.`
		: `Session ${label} is already open in ${tab}.`;
}

/** Throws errors whose message is shown as-is to the model or the user. */
export async function openSession(exec: Exec, request: SessionRequest, cwd: string, options: ScriptOptions = {}): Promise<string> {
	assertGhostty("open_session", options);
	if (!isSurface(request.surface)) {
		throw new Error(`Unknown surface "${request.surface}". Use one of: ${SURFACES.join(", ")}.`);
	}
	const session = await prepareSession(request, cwd, options);
	const live = session.resumed ? await findLiveSession(exec, options.liveDir ?? LIVE_DIR, session.resumed.id) : undefined;
	if (session.resumed && live) {
		return describeLive(session.resumed, live, await runScript(exec, GHOSTTY_FIND_SCRIPT, [live.tty, "focus"], options.signal, 15_000), true);
	}
	const stdout = await runScript(
		exec,
		GHOSTTY_SCRIPT,
		[request.surface, session.directory, session.input, await ownTty(exec)],
		options.signal,
		15_000,
	);

	return describeOpened(request.surface, stdout, session);
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
	const groups = await Promise.all(
		request.tabs.map(async (group, index) => {
			if (!group.sessions?.length) {
				throw new Error(`Tab ${index + 1} has no sessions.`);
			}

			return {
				title: group.title?.trim() ?? "",
				tab: group.tab?.trim() ?? "",
				sessions: await Promise.all(group.sessions.map((session) => prepareSession(session, cwd, options))),
			};
		}),
	);
	const resumedIds = groups.flatMap((group) => group.sessions.flatMap((session) => (session.resumed ? [session.resumed] : [])));
	const repeated = resumedIds.find((session, index) => resumedIds.findIndex((other) => other.id === session.id) !== index);
	if (repeated) {
		throw new Error(`Session ${sessionLabel(repeated)} appears twice in the request: a session can run in one pane only.`);
	}
	const alreadyOpen: string[] = [];
	for (const session of resumedIds) {
		const live = await findLiveSession(exec, options.liveDir ?? LIVE_DIR, session.id);
		if (live) {
			const stdout = await runScript(exec, GHOSTTY_FIND_SCRIPT, [live.tty, "locate"], options.signal, 15_000);
			alreadyOpen.push(describeLive(session, live, stdout, false));
		}
	}
	if (alreadyOpen.length > 0) {
		throw new Error(`Nothing opened. Remove these sessions from the request, they already run: ${alreadyOpen.join(" ")}`);
	}

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
			resumed: session.resumed?.id,
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
	session: Type.Optional(
		Type.String({
			description:
				"Existing session to resume instead of starting a new one: a session file path, or a full or partial session id. If it already runs, nothing opens and the result says where it runs; open_session also focuses its pane",
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description:
				"Folder to start in: absolute, relative to the working directory, or starting with ~/. Defaults to the folder of the resumed session, or else the working directory",
		}),
	),
	prompt: Type.Optional(
		Type.String({ description: "First message the new session runs, or the next message of a resumed one. Omit to open it idle" }),
	),
	model: Type.Optional(Type.String({ description: "Model for the new session, as provider/id with an optional :<thinking> suffix" })),
	name: Type.Optional(Type.String({ description: "Display name of the new session" })),
};

export default function ghosttySessionExtension(pi: ExtensionAPI): void {
	let registeredId: string | undefined;
	pi.on("session_start", async (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		if (ctx.mode !== "tui" || !ctx.sessionManager.getSessionFile()) {
			return;
		}
		const tty = await ownTty(pi.exec.bind(pi));
		if (tty) {
			registerLiveSession(LIVE_DIR, id, { pid: process.pid, tty });
			registeredId = id;
		}
	});
	pi.on("session_shutdown", () => {
		if (registeredId) {
			unregisterLiveSession(LIVE_DIR, registeredId, process.pid);
			registeredId = undefined;
		}
	});

	pi.registerTool({
		name: "open_session",
		label: "Open session",
		description:
			"Open a new interactive pi session in a Ghostty split, tab, or window on macOS, in the folder you choose and started with your prompt. The user can then join and drive it directly.",
		promptSnippet: "Open a new interactive pi session for the user in a Ghostty split, tab, or window",
		promptGuidelines: [
			"Use open_session when the user asks for a new session or agent they can join, not for a background subagent.",
			"Write the open_session prompt so it stands alone: the new session knows nothing about this conversation.",
			"To reopen an existing pi session, pass its id or session file as `session`. When the result says it already runs, tell the user where.",
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

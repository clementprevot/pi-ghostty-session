import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import {
	type BatchRequest,
	buildPiCommand,
	findLiveSession,
	GHOSTTY_BATCH_SCRIPT,
	GHOSTTY_FIND_SCRIPT,
	GHOSTTY_SCRIPT,
	isGhosttyOnMac,
	openSession,
	openSessions,
	parseCommandArgs,
	registerLiveSession,
	resolveDirectory,
	resolveSession,
	type SessionRequest,
	type StoredSession,
	shellQuote,
	unregisterLiveSession,
	writePromptFile,
} from "../index.ts";

const GHOSTTY = { env: { TERM_PROGRAM: "ghostty" }, platform: "darwin" };

type Call = { command: string; args: string[] };

function fakeExec(osascript: Partial<ExecResult> = {}, psTty = "ttys007", psCommand = "pi") {
	const calls: Call[] = [];
	const exec = async (command: string, args: string[]): Promise<ExecResult> => {
		calls.push({ command, args });
		const base = { stdout: "", stderr: "", code: 0, killed: false, truncated: false };
		if (command === "ps") {
			return { ...base, stdout: args.includes("tty=,command=") ? `${psTty} ${psCommand}\n` : `${psTty}\n` };
		}

		return { ...base, stdout: "own\ttab-1\tterm-1\n", ...osascript };
	};

	return { exec, calls };
}

function scriptArgs(calls: Call[]) {
	const call = calls.find((c) => c.command === "osascript");
	assert.ok(call, "osascript was not called");
	const [flag, , surface, directory, input, tty] = call.args;
	assert.equal(flag, "-e");

	return { surface, directory, input, tty };
}

function open(request: SessionRequest, exec = fakeExec().exec, cwd = tmpdir()) {
	const promptDir = mkdtempSync(join(tmpdir(), "pi-ghostty-session-test-"));

	return openSession(exec, request, cwd, { ...GHOSTTY, promptDir });
}

test("shellQuote survives single quotes in a real shell", () => {
	const value = `it's a "test" $HOME \`x\``;
	assert.equal(execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`]).toString(), value);
});

test("buildPiCommand passes model, name and the prompt file as a positional argument", () => {
	assert.equal(buildPiCommand({}), "pi");
	assert.equal(
		buildPiCommand({ promptFile: "/t/p.md", model: "anthropic/x:high", name: "Fix it" }),
		`pi --model 'anthropic/x:high' --name 'Fix it' "$(command cat '/t/p.md')"`,
	);
});

test("resolveDirectory expands ~ and resolves relative paths against cwd", () => {
	assert.equal(resolveDirectory(undefined, "/work", "/home/me"), "/work");
	assert.equal(resolveDirectory(" ", "/work", "/home/me"), "/work");
	assert.equal(resolveDirectory("~", "/work", "/home/me"), "/home/me");
	assert.equal(resolveDirectory("~/repo", "/work", "/home/me"), "/home/me/repo");
	assert.equal(resolveDirectory("../other", "/work/a", "/home/me"), "/work/other");
});

test("isGhosttyOnMac needs macOS and a Ghostty environment", () => {
	assert.equal(isGhosttyOnMac({ TERM_PROGRAM: "ghostty" }, "darwin"), true);
	assert.equal(isGhosttyOnMac({ TERM_PROGRAM: "tmux", GHOSTTY_RESOURCES_DIR: "/x" }, "darwin"), true);
	assert.equal(isGhosttyOnMac({ TERM_PROGRAM: "ghostty" }, "linux"), false);
	assert.equal(isGhosttyOnMac({ TERM_PROGRAM: "iTerm.app" }, "darwin"), false);
});

test("parseCommandArgs reads the surface then the prompt", () => {
	assert.deepEqual(parseCommandArgs("split-down"), { surface: "split-down" });
	assert.deepEqual(parseCommandArgs("  tab   fix the 'flaky' test\nnow "), { surface: "tab", prompt: "fix the 'flaky' test\nnow" });
	assert.equal(parseCommandArgs("sideways do it"), undefined);
	assert.equal(parseCommandArgs(""), undefined);
});

test("openSession hands the surface, folder, command and own tty to the script", async () => {
	const { exec, calls } = fakeExec();
	const cwd = mkdtempSync(join(tmpdir(), "pi-ghostty-session-cwd-"));
	const text = await open({ surface: "split-right", prompt: "  do the thing  ", model: "m/x" }, exec, cwd);
	const args = scriptArgs(calls);
	assert.equal(args.surface, "split-right");
	assert.equal(args.directory, cwd);
	assert.equal(args.tty, "/dev/ttys007");
	const match = args.input?.match(/^pi --model 'm\/x' "\$\(command cat '([^']+)'\)"\n$/);
	assert.ok(match, `unexpected input: ${args.input}`);
	assert.equal(readFileSync(match[1]!, "utf8"), "do the thing");
	assert.equal(statSync(match[1]!).mode & 0o777, 0o600);
	assert.match(text, /split to the right of this session/);
	assert.match(text, /started with the prompt/);
	assert.match(text, /tab id is tab-1 and its terminal id is term-1/);
});

test("a prompt that starts with - or @ still reaches pi as a message", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ghostty-session-test-"));
	for (const prompt of ["- step one\n- step two", "@file.md please"]) {
		const command = buildPiCommand({ promptFile: writePromptFile(prompt, dir) });
		const argv = execFileSync("sh", ["-c", `pi() { printf '%s\\0' "$@"; }; ${command}`]).toString().split("\0");
		assert.deepEqual(argv, [`\n${prompt}`, ""]);
	}
});

test("openSession without a prompt starts an idle pi and writes no file", async () => {
	const { exec, calls } = fakeExec({ stdout: "own" });
	assert.match(await open({ surface: "tab" }, exec), /new tab of this session's window, .* with no prompt/);
	assert.equal(scriptArgs(calls).input, "pi\n");
});

test("openSession sends an empty tty when ps finds no terminal", async () => {
	const { exec, calls } = fakeExec({}, "??");
	await open({ surface: "split-down" }, exec);
	assert.equal(scriptArgs(calls).tty, "");
});

test("openSession reports the fallbacks the script took", async () => {
	const front = await open({ surface: "split-up" }, fakeExec({ stdout: "front" }).exec);
	assert.match(front, /own Ghostty terminal was not found/);
	const noWindow = await open({ surface: "tab" }, fakeExec({ stdout: "window" }).exec);
	assert.match(noWindow, /new window, since no Ghostty window was open/);
	const window = await open({ surface: "window" }, fakeExec({ stdout: "window" }).exec);
	assert.doesNotMatch(window, /since no Ghostty window/);
});

test("openSession refuses outside Ghostty on macOS", async () => {
	const { exec, calls } = fakeExec();
	await assert.rejects(openSession(exec, { surface: "tab" }, tmpdir(), { env: {}, platform: "darwin" }), /inside Ghostty on macOS/);
	assert.equal(calls.length, 0);
});

test("openSession refuses an unknown surface and a missing folder", async () => {
	await assert.rejects(open({ surface: "sideways" as never }), /Unknown surface "sideways"/);
	await assert.rejects(open({ surface: "tab", cwd: "/definitely/not/here" }), /is not a directory/);
});

test("openSession turns osascript failures into readable errors", async () => {
	const denied = fakeExec({ code: 1, stderr: "execution error: Not authorized to send Apple events to Ghostty. (-1743)" });
	await assert.rejects(open({ surface: "tab" }, denied.exec), /Privacy & Security > Automation/);
	const other = fakeExec({ code: 1, stderr: "boom" });
	await assert.rejects(open({ surface: "tab" }, other.exec), /could not open the session: boom/);
	const silent = fakeExec({ code: 2 });
	await assert.rejects(open({ surface: "tab" }, silent.exec), /osascript exited with code 2/);
});

function openBatch(request: BatchRequest, exec = fakeExec().exec) {
	const promptDir = mkdtempSync(join(tmpdir(), "pi-ghostty-session-test-"));

	return openSessions(exec, request, tmpdir(), { ...GHOSTTY, promptDir });
}

const BATCH_OUTPUT = ["located\town", "tab\ttab-1", "terminal\tt-1", "terminal\tt-2", "tab\ttab-9", "terminal\tt-3", ""].join("\n");

test("openSessions flattens the tabs into argv and maps the ids back to each session", async () => {
	const { exec, calls } = fakeExec({ stdout: BATCH_OUTPUT });
	const { text, tabs } = await openBatch(
		{
			tabs: [
				{ title: " Jira ", sessions: [{ name: "a", prompt: "review a" }, { name: "b" }] },
				{ tab: "tab-9", sessions: [{ name: "c", cwd: "~" }] },
			],
		},
		exec,
	);
	const args = calls.find((call) => call.command === "osascript")!.args.slice(2);
	assert.deepEqual(args.slice(0, 6), ["tab", "/dev/ttys007", "2", "Jira", "", "2"]);
	assert.equal(args[6], tmpdir());
	assert.match(args[7]!, /^pi --name 'a' "\$\(command cat '[^']+'\)"\n$/);
	assert.deepEqual(args.slice(8, 13), [tmpdir(), "pi --name 'b'\n", "", "tab-9", "1"]);
	assert.equal(args[14], "pi --name 'c'\n");
	assert.deepEqual(
		tabs.map((tab) => [tab.id, tab.title, tab.sessions.map((session) => session.terminal)]),
		[
			["tab-1", "Jira", ["t-1", "t-2"]],
			["tab-9", undefined, ["t-3"]],
		],
	);
	assert.match(text, /^Opened 3 pi sessions:/);
	assert.match(text, /- tab "Jira" \(tab id tab-1\): a in .* \(terminal id t-1\), b in/);
	assert.match(text, /Pass a tab id as `tab`/);
});

test("openSessions mentions the front window fallback only when it opens new tabs", async () => {
	const front = "located\tfront\ntab\ttab-1\nterminal\tt-1\n";
	const newTab = await openBatch({ tabs: [{ sessions: [{}] }] }, fakeExec({ stdout: front }).exec);
	assert.match(newTab.text, /new tabs opened in the front window/);
	const existing = await openBatch({ tabs: [{ tab: "tab-1", sessions: [{}] }] }, fakeExec({ stdout: front }).exec);
	assert.doesNotMatch(existing.text, /front window/);
});

test("openSessions refuses a bad request before calling Ghostty", async () => {
	const { exec, calls } = fakeExec();
	await assert.rejects(openBatch({ tabs: [] }, exec), /at least one tab/);
	await assert.rejects(openBatch({ tabs: [{ sessions: [] }] }, exec), /Tab 1 has no sessions/);
	await assert.rejects(openBatch({ placement: "split" as never, tabs: [{ sessions: [{}] }] }, exec), /Unknown placement "split"/);
	await assert.rejects(openBatch({ tabs: [{ sessions: [{}, { cwd: "/definitely/not/here" }] }] }, exec), /is not a directory/);
	await assert.rejects(openSessions(exec, { tabs: [{ sessions: [{}] }] }, tmpdir(), { env: {}, platform: "darwin" }), /open_sessions needs pi/);
	assert.equal(calls.filter((call) => call.command === "osascript").length, 0);
});

test("the AppleScript sources compile", { skip: process.platform !== "darwin" }, () => {
	for (const script of [GHOSTTY_SCRIPT, GHOSTTY_BATCH_SCRIPT, GHOSTTY_FIND_SCRIPT]) {
		const output = join(mkdtempSync(join(tmpdir(), "pi-ghostty-session-scpt-")), "script.scpt");
		execFileSync("osacompile", ["-o", output, "-e", script]);
	}
});

function storedSession(id: string, name?: string): StoredSession {
	const cwd = mkdtempSync(join(tmpdir(), "pi-ghostty-session-project-"));
	const path = join(mkdtempSync(join(tmpdir(), "pi-ghostty-session-sessions-")), `2026_${id}.jsonl`);
	writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, cwd })}\n{"type":"message"}\n`);

	return { id, path, cwd, name };
}

function resumeOptions(sessions: StoredSession[], liveDir = mkdtempSync(join(tmpdir(), "pi-ghostty-session-live-"))) {
	return { ...GHOSTTY, promptDir: mkdtempSync(join(tmpdir(), "pi-ghostty-session-test-")), liveDir, listSessions: async () => sessions };
}

test("resolveSession reads a session file, or finds an id by exact match or unique prefix", async () => {
	const alpha = storedSession("01aa-alpha", "alpha");
	const beta = storedSession("01ab-beta");
	const list = async () => [alpha, beta];
	assert.deepEqual(await resolveSession(alpha.path, "/", list), { id: alpha.id, cwd: alpha.cwd, path: alpha.path });
	assert.equal((await resolveSession("01ab-beta", "/", list)).path, beta.path);
	assert.equal((await resolveSession("01aa", "/", list)).id, alpha.id);
	await assert.rejects(resolveSession("01a", "/", list), /matches 2 sessions \("alpha" \(01aa-alpha\) in .*; 01ab-beta in .*\)/);
	await assert.rejects(resolveSession("zz", "/", list), /No pi session matches "zz"/);
	const notSession = join(mkdtempSync(join(tmpdir(), "pi-ghostty-session-")), "notes.jsonl");
	writeFileSync(notSession, '{"type":"message"}\n');
	await assert.rejects(resolveSession(notSession, "/", list), /is not a pi session file/);
});

test("the live registry only trusts a pi process still on the recorded terminal", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-ghostty-session-live-"));
	registerLiveSession(dir, "s-1", { pid: 4242, tty: "/dev/ttys007" });
	assert.deepEqual(await findLiveSession(fakeExec().exec, dir, "s-1"), { pid: 4242, tty: "/dev/ttys007" });
	assert.equal(await findLiveSession(fakeExec({}, "ttys008").exec, dir, "s-1"), undefined);
	assert.equal(await findLiveSession(fakeExec({}, "ttys007", "zsh").exec, dir, "s-1"), undefined);
	assert.equal(await findLiveSession(fakeExec().exec, dir, "s-2"), undefined);
	unregisterLiveSession(dir, "s-1", 1);
	assert.ok(existsSync(join(dir, "s-1.json")), "another process must not remove the entry");
	unregisterLiveSession(dir, "s-1", 4242);
	assert.equal(existsSync(join(dir, "s-1.json")), false);
});

test("openSession resumes a stored session from its own folder", async () => {
	const session = storedSession("01aa-alpha", "alpha");
	const { exec, calls } = fakeExec();
	const text = await openSession(exec, { surface: "tab", session: "01aa", prompt: "carry on" }, tmpdir(), resumeOptions([session]));
	const args = scriptArgs(calls);
	assert.equal(args.directory, session.cwd);
	assert.match(args.input!, new RegExp(`^pi --session '${session.path}' "\\$\\(command cat '[^']+'\\)"\\n$`));
	assert.match(text, /^Resumed pi session "alpha" \(01aa-alpha\) in a new tab .* with the prompt as its next message/);
});

test("openSession focuses a session that already runs instead of opening it twice", async () => {
	const session = storedSession("01aa-alpha", "alpha");
	const options = resumeOptions([session]);
	registerLiveSession(options.liveDir, session.id, { pid: 4242, tty: "/dev/ttys007" });
	const { exec, calls } = fakeExec({ stdout: "tab-5\tReviews\n" });
	const text = await openSession(exec, { surface: "tab", session: session.id }, tmpdir(), options);
	const scripts = calls.filter((call) => call.command === "osascript");
	assert.equal(scripts.length, 1);
	assert.deepEqual(scripts[0]!.args.slice(1), [GHOSTTY_FIND_SCRIPT, "/dev/ttys007", "focus"]);
	assert.match(text, /already open, so no new pane opened\. Its pane, in the Ghostty tab "Reviews" \(tab id tab-5\), now has the focus/);
	const outside = await openSession(fakeExec({ stdout: "" }).exec, { surface: "tab", session: session.id }, tmpdir(), options);
	assert.match(outside, /pi process 4242 on \/dev\/ttys007, outside the Ghostty terminals/);
});

test("openSessions refuses a running or repeated session before opening anything", async () => {
	const alpha = storedSession("01aa-alpha", "alpha");
	const beta = storedSession("01ab-beta");
	const options = resumeOptions([alpha, beta]);
	const repeated = fakeExec();
	await assert.rejects(
		openSessions(repeated.exec, { tabs: [{ sessions: [{ session: alpha.id }, { session: alpha.path }] }] }, tmpdir(), options),
		/appears twice/,
	);
	registerLiveSession(options.liveDir, beta.id, { pid: 4242, tty: "/dev/ttys007" });
	const { exec, calls } = fakeExec({ stdout: "tab-5\tReviews\n" });
	await assert.rejects(
		openSessions(exec, { tabs: [{ sessions: [{ session: alpha.id }, { session: "01ab" }] }] }, tmpdir(), options),
		/Nothing opened\. .* Session 01ab-beta is already open in the Ghostty tab "Reviews"/,
	);
	assert.deepEqual(
		calls.filter((call) => call.command === "osascript").map((call) => call.args.slice(2)),
		[["/dev/ttys007", "locate"]],
	);
	assert.equal(repeated.calls.filter((call) => call.command === "osascript").length, 0);
});

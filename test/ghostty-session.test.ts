import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import {
	buildPiCommand,
	isGhosttyOnMac,
	openSession,
	parseCommandArgs,
	resolveDirectory,
	type SessionRequest,
	shellQuote,
} from "../index.ts";

const GHOSTTY = { env: { TERM_PROGRAM: "ghostty" }, platform: "darwin" };

type Call = { command: string; args: string[] };

function fakeExec(osascript: Partial<ExecResult> = {}, psTty = "ttys007") {
	const calls: Call[] = [];
	const exec = async (command: string, args: string[]): Promise<ExecResult> => {
		calls.push({ command, args });
		const base = { stdout: "", stderr: "", code: 0, killed: false, truncated: false };
		if (command === "ps") {
			return { ...base, stdout: `${psTty}\n` };
		}

		return { ...base, stdout: "own\n", ...osascript };
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

test("buildPiCommand passes model, name and the prompt file after --", () => {
	assert.equal(buildPiCommand({}), "pi");
	assert.equal(
		buildPiCommand({ promptFile: "/t/p.md", model: "anthropic/x:high", name: "Fix it" }),
		`pi --model 'anthropic/x:high' --name 'Fix it' -- "$(cat '/t/p.md')"`,
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
	const match = args.input?.match(/^pi --model 'm\/x' -- "\$\(cat '([^']+)'\)"\n$/);
	assert.ok(match, `unexpected input: ${args.input}`);
	assert.equal(readFileSync(match[1]!, "utf8"), "do the thing");
	assert.equal(statSync(match[1]!).mode & 0o777, 0o600);
	assert.match(text, /split to the right of this session/);
	assert.match(text, /started with the prompt/);
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

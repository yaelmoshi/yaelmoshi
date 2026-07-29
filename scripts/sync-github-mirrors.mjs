#!/usr/bin/env node

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const FORGEJO_BASE_URL = process.env.FORGEJO_BASE_URL ?? "https://git.m0sh1.cc";
const FORGEJO_OWNER = process.env.FORGEJO_OWNER ?? "isityael";
const FORGEJO_PUSH_TOKEN = process.env.FORGEJO_PUSH_TOKEN;
const FORGEJO_PUSH_USER = process.env.FORGEJO_PUSH_USER ?? "m0sh1";
const GITHUB_OWNER = process.env.GITHUB_OWNER ?? "isityael";
const GITHUB_PUSH_TOKEN =
	process.env.GITHUB_PUSH_TOKEN ?? process.env.GITHUB_TOKEN;

const MIRRORS = [
	["isityael", ["main"], "isityael"],
	["helm-charts", ["main"]],
	["proxmox-csi-plugin", ["main"]],
	["netzbremse", ["main"]],
	["harbor-helm", ["isityael/main"]],
	["wakapi-dhi", ["master"]],
	["csi-driver-nfs", ["isityael/dhi-hardening"]],
	["apple-mail-mcp", ["main"]],
	["chart-version-guard", ["main"]],
	["harbor", ["main", "progressed"]],
	["livesync-bridge", ["main"]],
	["livesync-commonlib", ["main"]],
	["infra", ["main"]],
];

if (!GITHUB_PUSH_TOKEN) {
	throw new Error("GITHUB_PUSH_TOKEN or GITHUB_TOKEN must be set");
}
if (!FORGEJO_PUSH_TOKEN) {
	throw new Error("FORGEJO_PUSH_TOKEN must be set");
}

function run(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			...options,
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});

		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve(stdout);
				return;
			}

			const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
			reject(new Error(`${command} ${args.join(" ")} failed: ${detail}`));
		});
	});
}

async function refSha(remoteUrl, branch) {
	const output = await run("git", [
		"ls-remote",
		remoteUrl,
		`refs/heads/${branch}`,
	]);
	const [sha] = output.trim().split(/\s+/);
	return sha || "";
}

async function mirrorBranch(repo, branch, githubRepo = repo) {
	const sourceUrl = `${FORGEJO_BASE_URL}/${FORGEJO_OWNER}/${repo}.git`;
	const targetUrl = `https://github.com/${GITHUB_OWNER}/${githubRepo}.git`;
	const sourceSha = await refSha(sourceUrl, branch);

	if (!sourceSha) {
		throw new Error(`${repo}:${branch} does not exist on Forgejo`);
	}

	const targetSha = await refSha(targetUrl, branch);
	if (targetSha === sourceSha) {
		console.log(`${repo}:${branch} already aligned at ${sourceSha}`);
		return;
	}

	const bareRepo = await mkdtemp(
		join(tmpdir(), `mirror-${repo.replaceAll("/", "-")}-`),
	);
	try {
		await run("git", ["init", "--bare"], { cwd: bareRepo });
		await run(
			"git",
			[
				"fetch",
				"--quiet",
				sourceUrl,
				`refs/heads/${branch}:refs/heads/${branch}`,
			],
			{ cwd: bareRepo },
		);
		await run(
			"git",
			[
				"push",
				"--force",
				targetUrl,
				`refs/heads/${branch}:refs/heads/${branch}`,
			],
			{ cwd: bareRepo },
		);

		console.log(
			`${repo}:${branch} mirrored ${targetSha || "(new)"} -> ${sourceSha}`,
		);
	} finally {
		await rm(bareRepo, { recursive: true, force: true });
	}
}

const netrcPath = join(homedir(), ".netrc");
await writeFile(
	netrcPath,
	`machine git.m0sh1.cc\n  login ${FORGEJO_PUSH_USER}\n  password ${FORGEJO_PUSH_TOKEN}\nmachine github.com\n  login x-access-token\n  password ${GITHUB_PUSH_TOKEN}\n`,
	{ mode: 0o600 },
);
await chmod(netrcPath, 0o600);

for (const [repo, branches, githubRepo] of MIRRORS) {
	for (const branch of branches) {
		await mirrorBranch(repo, branch, githubRepo);
	}
}

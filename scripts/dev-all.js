/**
 * Run the vite dev server and the API server together:
 *   npm run dev:all
 */

import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

function run(name, command, args) {
    const child = spawn(command, args, {
        stdio: "inherit",
        shell: isWindows,
        env: process.env,
    });
    child.on("exit", (code) => {
        console.log(`[${name}] exited with code ${code}`);
        process.exit(code ?? 0);
    });
    return child;
}

const npm = isWindows ? "npm.cmd" : "npm";

run("api", process.execPath, ["server/index.js"]);
run("web", npm, ["run", "dev"]);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

// Only launched by process-runner.test.js, in the runner's owned process group.
const { spawn } = require("node:child_process");
const descendant = spawn(
  process.execPath,
  ["-e", 'process.on("SIGTERM",()=>{}); process.stdout.write("READY"); setInterval(()=>{},1000);'],
  { stdio: ["ignore", "pipe", "ignore"], env: {} },
);
descendant.stdout.once("data", () => {
  process.stdout.write(`DESC:${descendant.pid}\n`);
  if (process.argv.includes("--leader-exits")) process.exit(0);
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);

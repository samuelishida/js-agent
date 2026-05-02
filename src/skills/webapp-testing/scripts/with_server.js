#!/usr/bin/env node
/**
 * Start one or more servers, wait for them to be ready, run a command, then clean up.
 *
 * Usage:
 *   # Single server
 *   node with_server.js --server "npm run dev" --port 5173 -- node automation.js
 *   node with_server.js --server "npm start" --port 3000 -- node test.js
 *
 *   # Multiple servers
 *   node with_server.js \
 *     --server "cd backend && node server.js" --port 3000 \
 *     --server "cd frontend && npm run dev" --port 5173 \
 *     -- node test.js
 */

const { spawn, execSync } = require('child_process');
const net = require('net');

function isServerReady(port, timeout = 30000) {
  const start = Date.now();
  return new Promise((resolve) => {
    function check() {
      if (Date.now() - start > timeout) {
        resolve(false);
        return;
      }
      const socket = net.createConnection({ host: 'localhost', port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        setTimeout(check, 500);
      });
    }
    check();
  });
}

async function main() {
  const args = process.argv.slice(2);

  // Parse --server, --port, --timeout, and command (after --)
  const servers = [];
  const ports = [];
  let timeout = 30;
  let command = [];

  let i = 0;
  while (i < args.length) {
    if (args[i] === '--server') { servers.push(args[++i]); i++; }
    else if (args[i] === '--port') { ports.push(parseInt(args[++i], 10)); i++; }
    else if (args[i] === '--timeout') { timeout = parseInt(args[++i], 10); i++; }
    else if (args[i] === '--') { command = args.slice(i + 1); break; }
    else { i++; }
  }

  if (servers.length === 0) {
    console.error('Error: At least one --server is required');
    process.exit(1);
  }
  if (ports.length !== servers.length) {
    console.error('Error: Number of --server and --port arguments must match');
    process.exit(1);
  }
  if (command.length === 0) {
    console.error('Error: No command specified to run (use -- before the command)');
    process.exit(1);
  }

  const serverProcesses = [];

  try {
    // Start all servers
    for (let j = 0; j < servers.length; j++) {
      console.log(`Starting server ${j + 1}/${servers.length}: ${servers[j]}`);
      const proc = spawn(servers[j], [], { shell: true, stdio: 'pipe' });
      serverProcesses.push(proc);

      console.log(`Waiting for server on port ${ports[j]}...`);
      const ready = await isServerReady(ports[j], timeout * 1000);
      if (!ready) {
        throw new Error(`Server failed to start on port ${ports[j]} within ${timeout}s`);
      }
      console.log(`Server ready on port ${ports[j]}`);
    }

    console.log(`\nAll ${servers.length} server(s) ready`);

    // Run the command
    console.log(`Running: ${command.join(' ')}\n`);
    const result = spawn(command[0], command.slice(1), { stdio: 'inherit' });
    await new Promise((resolve) => result.on('close', (code) => {
      process.exitCode = code || 0;
      resolve();
    }));
  } finally {
    // Clean up all servers
    console.log(`\nStopping ${serverProcesses.length} server(s)...`);
    for (let j = 0; j < serverProcesses.length; j++) {
      try {
        serverProcesses[j].kill('SIGTERM');
        await new Promise((resolve) => {
          const t = setTimeout(() => {
            serverProcesses[j].kill('SIGKILL');
            resolve();
          }, 5000);
          serverProcesses[j].on('exit', () => { clearTimeout(t); resolve(); });
        });
      } catch (_) { /* ignore */ }
      console.log(`Server ${j + 1} stopped`);
    }
    console.log('All servers stopped');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
#!/usr/bin/env node
// Claude Code hook → claude-mobile. Must never fail and never hold Claude up for long.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

// Only these fields are ever forwarded. In particular PostToolUse carries a `tool_response`
// that can be huge (file contents, command output); the server only needs to know what kind
// of event happened and where to find the transcript, never the full tool payload.
const EVENT_FIELDS = ['hook_event_name', 'session_id', 'transcript_path', 'message', 'notification_type'];

function pickEvent(event) {
  const out = {};
  for (const key of EVENT_FIELDS) {
    if (key in event) out[key] = event[key];
  }
  return out;
}

// Very small KEY=VALUE parser for ~/.config/claude-mobile/env. The hook runs inside a Claude
// Code session, which never has CLAUDE_MOBILE_LISTEN/CLAUDE_MOBILE_PORT in its own
// environment (those are only exported into the claude-mobile server's process), so this file
// is how the hook learns whether the server is listening on a unix socket instead of TCP.
function readEnvFile(file) {
  const out = {};
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// Builds the http.request() options to reach claude-mobile, favoring an explicit unix socket
// (CLAUDE_MOBILE_LISTEN=unix:...) over TCP, from the process environment first and the env
// file second.
function requestOptions(env, fileEnv) {
  const listen = env.CLAUDE_MOBILE_LISTEN || fileEnv.CLAUDE_MOBILE_LISTEN || '';
  const base = { path: '/internal/hook', method: 'POST', timeout: 2000 };
  if (listen.startsWith('unix:')) return { ...base, socketPath: listen.slice('unix:'.length) };
  return { ...base, host: '127.0.0.1', port: Number(env.CLAUDE_MOBILE_PORT || fileEnv.CLAUDE_MOBILE_PORT || 8787) };
}

function main() {
  if (!process.env.TMUX) return;
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  const args = ['display-message', '-p'];
  if (process.env.TMUX_PANE) args.push('-t', process.env.TMUX_PANE);
  args.push('#S');
  const tmuxSession = execFileSync('tmux', args, { encoding: 'utf8', timeout: 1000 }).trim();
  if (!tmuxSession.startsWith('claude-')) return;
  const base = process.env.CLAUDE_MOBILE_HOME || path.join(os.homedir(), '.config', 'claude-mobile');
  const secret = fs.readFileSync(path.join(base, 'hook-secret'), 'utf8').trim();
  const fileEnv = readEnvFile(path.join(base, 'env'));
  const body = JSON.stringify({ tmuxSession, event: pickEvent(event) });
  const req = http.request({
    ...requestOptions(process.env, fileEnv),
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-hook-secret': secret },
  }, (res) => res.resume());
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(body);
}

if (require.main === module) {
  try {
    main();
  } catch {
    // Swallow everything: a broken hook must not affect Claude.
  }
}

module.exports = { pickEvent, readEnvFile, requestOptions };

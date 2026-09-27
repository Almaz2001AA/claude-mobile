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
  const body = JSON.stringify({ tmuxSession, event: pickEvent(event) });
  const req = http.request({
    host: '127.0.0.1',
    port: Number(process.env.CLAUDE_MOBILE_PORT || 8787),
    path: '/internal/hook',
    method: 'POST',
    timeout: 2000,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-hook-secret': secret },
  }, (res) => res.resume());
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end(body);
}

try {
  main();
} catch {
  // Swallow everything: a broken hook must not affect Claude.
}

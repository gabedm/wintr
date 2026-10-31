import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WindowsPersonalSecrets } from '../src/server/windows-secrets.js';
import { acquirePersonalSetup, connectPersonalGoogle } from '../src/server/personal-connect.js';
import { desktopCommand } from '../src/server/desktop-launcher.js';
import { finishPersonalSetup } from '../src/server/personal-setup.js';
import { spawn } from 'node:child_process';
const state = vi.hoisted(() => ({ exit: 1, observedAdc: '', held: false }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn((_file, args) => {
  const child = new EventEmitter() as any;
  child.pid = process.pid; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn(() => true);
  if (args[0] === 'setup-lock') {
    if (state.held) queueMicrotask(() => child.emit('exit', 2));
    else { state.held = true; queueMicrotask(() => child.stdout.write('locked\n')); child.stdin.once('finish', () => { state.held = false; child.emit('exit', 0); }); }
  } else { if (state.observedAdc) expect(existsSync(state.observedAdc)).toBe(false); queueMicrotask(() => child.emit('exit', state.exit)); }
  return child;
}) }));
vi.mock('../src/server/desktop-launcher.js', () => ({ desktopCommand: vi.fn(async () => ({ ok: true })) }));
vi.mock('../src/server/personal-setup.js', async original => ({ ...await original<typeof import('../src/server/personal-setup.js')>(), finishPersonalSetup: vi.fn(() => ({ ok: true })) }));
const dirs: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'wintr-connect-invented-')); dirs.push(dir); return dir; };
afterEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); state.exit = 1; state.observedAdc = ''; state.held = false;
  for (const dir of dirs.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/') + 'wintr-connect-invented-')) throw Error('Unexpected test path');
    rmSync(dir, { recursive: true });
  }
});
function prepared() {
  const dir = directory(), sdk = join(dir, 'invented-sdk');
  for (const part of ['platform/bundledpython', 'lib']) mkdirSync(join(sdk, part), { recursive: true });
  writeFileSync(join(sdk, 'platform/bundledpython/python.exe'), 'invented-not-executable'); writeFileSync(join(sdk, 'lib/gcloud.py'), 'invented-not-executable');
  const p = { schema: 1, profileId: 'a'.repeat(32), approved: true, approvalId: 'call_invented_connect', approvedAt: Date.now() - 1000,
    authority: 'until_revoked', enabled: true, projectId: 'invented-project', quotaProjectId: 'invented-project', geminiProjectId: 'invented-gemini', databaseId: 'invented-db',
    runtimeServiceAccount: 'wintr-runtime@invented-project.iam.gserviceaccount.com', serviceId: 'svc-invented-connect', serviceIdentity: 'runtime-invented', settlementOwner: 'owner-invented', port: 4876,
    baseline: { currency: 'GBP', counts: { qloo: 0, gemini: 0 }, unitsHeld: 0, active: 0, unresolved: 0 }, allowance: { gbpMinor: 10000, qloo: 120, gemini: 80 },
    deniedVideoIds: [], deniedRecordedDigests: [], recordedMusicApprovalId: null };
  writeFileSync(join(dir, 'setup-approved.json'), JSON.stringify(p)); writeFileSync(join(dir, 'setup-tools.json'), JSON.stringify({ schema: 1, sdkRoot: sdk }));
  vi.spyOn(WindowsPersonalSecrets.prototype, 'providers').mockReturnValue({} as any); vi.spyOn(WindowsPersonalSecrets.prototype, 'desktopKey').mockReturnValue('b'.repeat(64));
  return dir;
}
it('serializes setup without touching another live setup or its temporary file', async () => {
  const dir = directory(), held = await acquirePersonalSetup(dir, 'invented-helper', 'a'.repeat(32));
  await expect(acquirePersonalSetup(dir, 'invented-helper', 'a'.repeat(32))).rejects.toThrow('already_starting'); await held.release();
  const next = await acquirePersonalSetup(dir, 'invented-helper', 'a'.repeat(32)); await next.release(); expect(existsSync(join(dir, 'setup-lock.json'))).toBe(false);
});
it('reclaims a proven dead lock using only zero-signal process checks', async () => {
  const dir = directory(); writeFileSync(join(dir, 'setup-lock.json'), JSON.stringify({ schema: 1, pid: 987654, childPid: null, nonce: 'c'.repeat(32) }));
  const check = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(Error('invented dead pid'), { code: 'ESRCH' }); });
  const lock = await acquirePersonalSetup(dir, 'invented-helper', 'a'.repeat(32)); expect(check).toHaveBeenCalledWith(987654, 0); await lock.release();
});
it('explicit retry removes only its abandoned app ADC and never gets stuck on the next attempt', async () => {
  const dir = prepared(); mkdirSync(join(dir, 'onboarding')); const adc = join(dir, 'onboarding/application_default_credentials.json');
  writeFileSync(adc, '{"invented":"partial credential"}'); state.observedAdc = adc;
  await expect(connectPersonalGoogle(dir, 'invented-helper')).rejects.toThrow('sign_in_required');
  await expect(connectPersonalGoogle(dir, 'invented-helper')).rejects.toThrow('sign_in_required');
  expect(vi.mocked(spawn).mock.calls.filter(([, args]) => args?.[0] !== 'setup-lock')).toHaveLength(2); expect(existsSync(adc)).toBe(false); expect(existsSync(join(dir, 'setup-lock.json'))).toBe(false);
});
it('successful protected reconnect waits for the exact old runtime to stop', async () => {
  const dir = prepared(); state.exit = 0;
  expect(await connectPersonalGoogle(dir, 'invented-helper')).toEqual({ ok: true });
  expect(finishPersonalSetup).toHaveBeenCalledWith(dir, 'invented-helper');
  expect(desktopCommand).toHaveBeenCalledWith('stop-and-wait', dir); expect(existsSync(join(dir, 'setup-lock.json'))).toBe(false);
});

import { existsSync,mkdtempSync,readFileSync,rmSync,unlinkSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { capturePersonalLivePermission,createPersonalLivePermission,parsePersonalLivePermission,PERSONAL_LIVE_FILE } from '../src/server/personal-live.js';
import { parsePersonalProfile,personalBindings,personalFingerprint } from '../src/server/personal-profile.js';
import { runPersonalApp } from '../src/server/personal-entry.js';
import { WindowsPersonalSecrets } from '../src/server/windows-secrets.js';

const T=1000;
const raw=()=>({schema:1,profileId:'a'.repeat(32),approved:true,approvalId:'call_invented_personal_approval',approvedAt:T,authority:'until_revoked',enabled:true,
  projectId:'invented-project',quotaProjectId:'invented-project',geminiProjectId:'invented-gemini-project',databaseId:'invented-database',runtimeServiceAccount:'invented-runtime@invented-project.iam.gserviceaccount.com',
  serviceId:'svc-invented-personal',serviceIdentity:'runtime-invented',settlementOwner:'owner-invented',port:4876,
  baseline:{currency:'GBP',counts:{qloo:8,gemini:7},unitsHeld:600,unresolved:15,active:0},allowance:{gbpMinor:10000,qloo:120,gemini:80},
  deniedVideoIds:[],deniedRecordedDigests:[],recordedMusicApprovalId:'call_invented_recording_approval'});
const directories:string[]=[];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'wintr-live-invented-'));directories.push(dir);const base=parsePersonalProfile(raw(),T),bytes=JSON.stringify(base);
  writeFileSync(join(dir,'profile.json'),bytes);writeFileSync(join(dir,'setup-approved.json'),bytes);
  const permission=createPersonalLivePermission(base,'call_invented_live_approval',T),file=join(dir,PERSONAL_LIVE_FILE);
  const publish=()=>writeFileSync(file,JSON.stringify(permission),{flag:'wx'});
  return{dir,base,permission,file,publish,bytes};}
afterEach(()=>{vi.restoreAllMocks();for(const dir of directories.splice(0)){const path=resolve(dir);if(!path.startsWith(resolve(tmpdir())+sep)||!path.split(sep).at(-1)!.startsWith('wintr-live-invented-'))throw Error('unsafe test cleanup');rmSync(path,{recursive:true,force:true});}});
describe('independent readonly personal Live permission',()=>{
  it('does not inherit recording authority and never rewrites either original approval',()=>{
    const f=fixture();expect(capturePersonalLivePermission(f.dir,f.base,T)).toBeNull();expect(personalBindings(f.base,T).liveListening).toBeUndefined();
    f.publish();const live=capturePersonalLivePermission(f.dir,f.base,T)!;live.checkAuthority();
    expect(live.approvalId).toBe('call_invented_live_approval');expect(personalBindings(f.base,T,live.approvalId).liveListening?.model).toBe('gemini-3.8-live');
    expect(readFileSync(join(f.dir,'profile.json'),'utf8')).toBe(f.bytes);expect(readFileSync(join(f.dir,'setup-approved.json'),'utf8')).toBe(f.bytes);
    expect(personalFingerprint(f.base)).toBe(f.permission.profileFingerprint);
  });
  it.each(['delete-base','delete-anchor','disable-base','change-base','delete-live','change-live'] as const)('%s revokes without recreating anything',kind=>{
    const f=fixture();f.publish();const live=capturePersonalLivePermission(f.dir,f.base,T)!;
    if(kind==='delete-base')unlinkSync(join(f.dir,'profile.json'));else if(kind==='delete-anchor')unlinkSync(join(f.dir,'setup-approved.json'));
    else if(kind==='delete-live')unlinkSync(f.file);else if(kind==='change-live')writeFileSync(f.file,JSON.stringify({...f.permission,approvalId:'call_invented_other_approval'}));
    else{const changed={...f.base,...(kind==='disable-base'?{enabled:false}:{allowance:{...f.base.allowance,gbpMinor:12000}})};writeFileSync(join(f.dir,'profile.json'),JSON.stringify(changed));}
    expect(()=>live.checkAuthority()).toThrow();
    if(kind==='delete-base')expect(existsSync(join(f.dir,'profile.json'))).toBe(false);
    if(kind==='delete-anchor')expect(existsSync(join(f.dir,'setup-approved.json'))).toBe(false);
    if(kind==='delete-live'){expect(existsSync(f.file)).toBe(false);expect(capturePersonalLivePermission(f.dir,f.base,T)).toBeNull();}
  });
  it('cannot copy permission to another profile, change caps or override a recording refusal',()=>{
    const f=fixture(),other=parsePersonalProfile({...raw(),profileId:'b'.repeat(32)},T);
    expect(()=>parsePersonalLivePermission(f.permission,other,T)).toThrow();
    const denied=parsePersonalProfile({...raw(),deniedRecordedDigests:['a'.repeat(64)]},T);
    expect(()=>createPersonalLivePermission(denied,'call_invented_live_approval',T)).toThrow();
    const changed=parsePersonalProfile({...raw(),allowance:{...raw().allowance,gemini:100}},T);
    expect(()=>parsePersonalLivePermission(f.permission,changed,T)).toThrow();
  });
  it.each([{model:'other-model'},{maxSeconds:60},{maxOutputTokens:8192},{retention:'no_retention'},{endpoint:'wss://invented.invalid'}])('refuses altered provider configuration %j',change=>{
    const f=fixture();expect(()=>parsePersonalLivePermission({...f.permission,profile:{...f.permission.profile,...change}},f.base,T)).toThrow();
  });
  it('rejects unknown/inherited/getter grants without evaluating getters',()=>{
    const f=fixture(),getter=vi.fn(()=>f.permission.approvalId),accessor={...f.permission};Object.defineProperty(accessor,'approvalId',{get:getter});
    expect(()=>parsePersonalLivePermission(accessor,f.base,T)).toThrow();expect(getter).not.toHaveBeenCalled();
    expect(()=>parsePersonalLivePermission({...f.permission,extra:true},f.base,T)).toThrow();
    expect(()=>parsePersonalLivePermission(Object.create(f.permission),f.base,T)).toThrow();
  });
  it('refuses malformed optional permission at startup before any protected load',async()=>{
    const f=fixture();writeFileSync(f.file,JSON.stringify({...f.permission,profileFingerprint:'b'.repeat(64)}));
    const read=vi.spyOn(WindowsPersonalSecrets.prototype,'read').mockImplementation(()=>{throw Error('invented protected read');});
    await expect(runPersonalApp(f.dir)).rejects.toThrow();expect(read).not.toHaveBeenCalled();
  });
});

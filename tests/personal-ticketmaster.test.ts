import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { captureWindowsTicketmaster, parseTicketmasterPacket } from '../src/server/personal-ticketmaster.js';
import type { PersonalProfile } from '../src/server/personal-profile.js';
const id='a'.repeat(32), now=Date.now();
const packet=()=>({schema:1,kind:'wintr-ticketmaster-v1',profileId:id,approved:true,authority:'until_revoked',dailyLimit:250,createdAt:now-1,apiKey:'invented_ticketmaster_key_not_real'});
describe('optional protected Ticketmaster connection',()=>{
  it('accepts only the explicitly bound independent packet',()=>{expect(parseTicketmasterPacket(packet(),id,now).validUntil).toBeGreaterThan(now);for(const change of [{approved:false},{profileId:'b'.repeat(32)},{dailyLimit:5000},{kind:'wintr-personal-providers-v1'},{apiKey:'x\nsecret'},{createdAt:now+1},{extra:'unapproved'}])expect(()=>parseTicketmasterPacket({...packet(),...change},id,now)).toThrow();expect(()=>parseTicketmasterPacket(packet(),id,NaN)).toThrow();});
  it('rejects a credential accessor without invoking it',()=>{let reads=0;const raw=packet();Object.defineProperty(raw,'apiKey',{get(){reads++;return'invented';}});expect(()=>parseTicketmasterPacket(raw,id,now)).toThrow();expect(reads).toBe(0);});
  it('allows the first owner-entered file after boot but latches a later removal/replacement off',()=>{
    const directory=mkdtempSync(join(tmpdir(),'wintr-ticket-test-')), file=join(directory,'ticketmaster.dpapi');
    try{const plain=Buffer.from(JSON.stringify(packet())), decrypt=vi.fn(()=>plain), check=vi.fn();const connection=captureWindowsTicketmaster(directory,{profileId:id} as PersonalProfile,'unused',check,decrypt);
      expect(connection.access()).toBeNull();expect(decrypt).not.toHaveBeenCalled();writeFileSync(file,'invented-ciphertext');expect(connection.access()?.apiKey).toBe(packet().apiKey);expect(plain.every(v=>v===0)).toBe(true);expect(decrypt).toHaveBeenCalledOnce();expect(connection.access()).not.toBeNull();expect(decrypt).toHaveBeenCalledOnce();
      unlinkSync(file);expect(connection.access()).toBeNull();writeFileSync(file,'invented-ciphertext');expect(connection.access()).toBeNull();expect(decrypt).toHaveBeenCalledOnce();
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
  it('refuses changed base authority before loading a protected file',()=>{const directory=mkdtempSync(join(tmpdir(),'wintr-ticket-test-'));try{writeFileSync(join(directory,'ticketmaster.dpapi'),'invented-ciphertext');const decrypt=vi.fn(()=>Buffer.from(JSON.stringify(packet())));const c=captureWindowsTicketmaster(directory,{profileId:id} as PersonalProfile,'unused',()=>{throw new Error('revoked');},decrypt);expect(c.access()).toBeNull();expect(decrypt).not.toHaveBeenCalled();}finally{rmSync(directory,{recursive:true,force:true});}});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {computerKind, computerStatus, tailscaleStatus, workspaceIdentity} from '../mods/sixfold-desk/sidebar-identity.js';

test('network discovery never claims an SSH or Herdr connection', () => {
  assert.equal(computerStatus({name:null,layout:'ready'}),'이 Mac');
  assert.equal(computerStatus({name:'server',layout:'ready'}),'Herdr 원격 · 연결됨');
  assert.equal(computerStatus({name:'server',layout:'unavailable'}),'Herdr 원격 · 끊김');
  assert.equal(computerStatus({name:'server',layout:'loading'}),'Herdr 원격 · 연결 중');
  assert.equal(tailscaleStatus({online:true}),'Tailscale 온라인 · SSH 미등록');
  assert.equal(tailscaleStatus({online:false}),'Tailscale 오프라인');
  assert.equal(tailscaleStatus({online:null}),'Tailscale 상태 미확인');
  assert.equal(tailscaleStatus({}),'Tailscale 상태 미확인');
});

test('device and known workspace identities select local artwork with stable fallback', () => {
  assert.deepEqual(['macOS','windows','iPadOS','iOS','android','linux',null].map(computerKind),
    ['laptop','desktop','tablet','phone','phone','computer','computer']);
  assert.equal(computerKind('iOS','ipad-pro-12-9-gen-3'),'tablet');
  assert.equal(computerKind('iOS','iphone-14-plus'),'phone');
  assert.deepEqual(['공통','PeaceMinusOne','Medihomes','Voice','Herdr','New project'].map(name=>workspaceIdentity({name})),
    ['hub','flower','medical','microphone','terminal',null]);
});

test('Share keeps the hub identity after renaming', () => {
  assert.equal(workspaceIdentity({name:'Share'}), 'hub');
  assert.equal(workspaceIdentity({id:'sp5b1f0e5ae362facabc5ac1ece5d08277',name:'Renamed'}), 'hub');
});

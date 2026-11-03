import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { liveExchange } from "../scripts/helpers/live-rpc.mjs";

class Socket extends EventEmitter {
  readyState = 1;
  action = () => {};
  sent = 0;
  send(_frame: string, done: (error?: Error) => void) { this.sent++; this.action(); done(); }
}
const clean = (socket: Socket) => {
  for (const event of ["message", "error", "close"]) assert.equal(socket.listenerCount(event), 0, event);
};

test("live checker rejects a disconnected cleanup socket without sending or waiting", async () => {
  const socket = new Socket(); socket.readyState = 3;
  await assert.rejects(liveExchange(socket, {private:"never logged"}), /not open/);
  assert.equal(socket.sent, 0); clean(socket);
});

test("live checker handles connection closure and transport errors during a request", async () => {
  for (const event of ["close", "error"]) {
    const socket = new Socket(); socket.action = () => queueMicrotask(() => socket.emit(event, event === "close" ? 1006 : new Error("private transport details")));
    await assert.rejects(liveExchange(socket, {}), /Live RPC connection (closed|failed)/); clean(socket);
  }
});

test("live checker captures synchronous replies and removes only its own listeners", async () => {
  const socket = new Socket(), observer = () => {};
  socket.on("message", observer); socket.action = () => { socket.emit("message", Buffer.from('{"type":"box","value":7}')); };
  assert.deepEqual(await liveExchange(socket, {}), {type:"box",value:7});
  assert.equal(socket.listenerCount("message"),1); socket.off("message",observer); clean(socket);
});

test("live checker rejects invalid responses without exposing request or response credentials", async () => {
  for (const response of ["private-credential",'null','[]','7','"private-credential"','{"type":"error","message":"private-credential"}']) {
    const socket = new Socket(); socket.action = () => { socket.emit("message",Buffer.from(response)); };
    await assert.rejects(liveExchange(socket,{private:"private-credential"}), (error:Error) => !error.message.includes("private-credential")); clean(socket);
  }
});

test("live checker handles a failed send and bounds a silent connection", async () => {
  const failed = new Socket(); failed.send = () => { throw new Error("private-credential"); };
  await assert.rejects(liveExchange(failed,{}),/connection failed/); clean(failed);
  const silent = new Socket(); await assert.rejects(liveExchange(silent,{},15),/timed out/); clean(silent);
});

test("referenced cleanup timeout keeps Node alive long enough to persist a failed report", () => {
  const directory=mkdtempSync(join(tmpdir(),"qahwa-live-check-"));
  try {
    const path=join(directory,"report.json");
    const program=`import {EventEmitter} from 'node:events';import {writeFileSync} from 'node:fs';
      import {liveExchange} from ${JSON.stringify(new URL('../scripts/helpers/live-rpc.mjs',import.meta.url).href)};
      const socket=new EventEmitter();socket.readyState=1;socket.send=()=>{};const report={passed:false};
      try{await liveExchange(socket,{},20)}catch{report.cleanupError='bounded timeout'}finally{writeFileSync(${JSON.stringify(path)},JSON.stringify(report))}`;
    const result=spawnSync(process.execPath,["--input-type=module","-e",program],{encoding:"utf8",timeout:3000});
    assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stderr,/unsettled top-level await/);
    assert.deepEqual(JSON.parse(readFileSync(path,"utf8")),{passed:false,cleanupError:"bounded timeout"});
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

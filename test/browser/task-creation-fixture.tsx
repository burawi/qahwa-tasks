import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from 'creation-app';
import { api, connection } from 'creation-api';
import 'creation-styles';

const originalCreate = api.createTask;
const fixture = window.creationFixture = { pair: uri => connection.pair(uri), saves: [], loseResponse: false, saveDelay: 0 };
api.createTask = async value => {
  fixture.saves.push(structuredClone(value));
  if (fixture.saveDelay) await new Promise(resolve => setTimeout(resolve, fixture.saveDelay));
  const result = await originalCreate(value);
  if (fixture.loseResponse) { fixture.loseResponse = false; throw new Error('Simulated lost save response after commit'); }
  return result;
};
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);

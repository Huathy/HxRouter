// In-process change bus for the model catalog.
//
// Provider / combo / model registries are edited through the API routes, and
// the playground (and any other consumer) needs to refresh its model list the
// moment one of those edits lands. The routes call
// notifyModelCatalogChanged() and connected clients pick the change up from
// the SSE endpoint at /api/models/events.

import { EventEmitter } from "events";

const STATE_KEY = "_modelCatalogEventsState";

function getState() {
  if (!globalThis[STATE_KEY]) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(100);
    globalThis[STATE_KEY] = { emitter, version: 0 };
  }
  return globalThis[STATE_KEY];
}

export function getModelCatalogEmitter() {
  return getState().emitter;
}

export function getModelCatalogVersion() {
  return getState().version;
}

export function notifyModelCatalogChanged(reason = "update") {
  const state = getState();
  state.version += 1;
  state.emitter.emit("changed", {
    version: state.version,
    reason,
    at: Date.now(),
  });
}

import { EventEmitter } from 'node:events';

/** In-process pub/sub keyed by video uuid; feeds the SSE endpoint. */
export function createHub() {
  const em = new EventEmitter();
  em.setMaxListeners(0);
  return {
    emit: (uuid, event, data) => em.emit(uuid, event, data),
    subscribe(uuid, fn) {
      em.on(uuid, fn);
      return () => em.off(uuid, fn);
    },
  };
}

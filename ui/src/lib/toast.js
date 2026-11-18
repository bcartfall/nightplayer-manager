import { reactive } from 'vue';

export const toasts = reactive([]);
let next = 1;

export function toast(message, kind = 'info', ms = 4500) {
  const t = { id: next++, message, kind };
  toasts.push(t);
  setTimeout(() => dismiss(t.id), ms);
}
export function dismiss(id) {
  const i = toasts.findIndex((t) => t.id === id);
  if (i !== -1) toasts.splice(i, 1);
}

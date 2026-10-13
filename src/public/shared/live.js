const MAX_RETRY_MS = 5000;

/**
 * Keeps a WebSocket to the server open, reconnecting with backoff.
 * `query()` is called on every attempt so it can supply the current token.
 * `onStatus(true|false)` fires whenever the connection comes up or drops.
 */
export function connectLive({ query, onEvent, onStatus }) {
  let socket = null;
  let closed = false;
  let delay = 500;
  let timer = null;

  function open() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}/ws?${query()}`);
    socket.onopen = () => {
      delay = 500;
      onStatus(true);
    };
    socket.onmessage = (message) => onEvent(JSON.parse(message.data));
    socket.onclose = () => {
      onStatus(false);
      if (closed) return;
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    };
  }

  open();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      socket.close();
    },
  };
}

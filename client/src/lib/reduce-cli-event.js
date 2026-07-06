// STUB — full CLI-event -> SessionState reduction is implemented in Task 7.
// Contract: pure function `reduceCliEvent(sessionState, payload) => sessionState`.
// Until then: preserve every payload as a raw message so nothing is lost.

export function reduceCliEvent(session, payload) {
  return {
    ...session,
    messages: [...session.messages, { kind: 'raw', payload }],
  };
}

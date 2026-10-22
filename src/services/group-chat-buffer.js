'use strict';

// Lightweight in-process buffer used by the message handler to remember recent
// group messages. The old daily group-chat scheduler was removed, but this
// runtime buffer is still part of the normal Feishu message chain.

const messageBuffer = new Map();

function addMessage(chatId, openId, userName, content, timestamp) {
  if (!chatId) return;
  if (!messageBuffer.has(chatId)) {
    messageBuffer.set(chatId, []);
  }

  const buffer = messageBuffer.get(chatId);
  buffer.push({ openId, userName, content, timestamp });

  if (buffer.length > 2000) {
    messageBuffer.set(chatId, buffer.slice(-1500));
  }
}

function getMessages(chatId) {
  return messageBuffer.get(chatId) || [];
}

function clearOldMessages(maxAgeMs = 6 * 3600 * 1000) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [chatId, messages] of messageBuffer) {
    const kept = messages.filter(message => Number(message.timestamp) > cutoff);
    if (kept.length > 0) {
      messageBuffer.set(chatId, kept);
    } else {
      messageBuffer.delete(chatId);
    }
  }
}

module.exports = {
  addMessage,
  getMessages,
  clearOldMessages,
};

import test from "node:test";
import assert from "node:assert/strict";
import { createSendCoordinator } from "../web/chat/send.js";

test("an unconfirmed send can retry while busy without unlocking the other draft", async () => {
  const first = Promise.withResolvers();
  const submitted = [];
  const cleared = [];
  let busy = false;
  let nextId = 0;
  const sender = createSendCoordinator({
    submit(body) {
      submitted.push(body);
      if (submitted.length === 1) return first.promise;
    },
    requestId: () => String(++nextId),
    isAvailable: () => true,
    isBusy: () => busy,
    onChange() {},
    onAccepted() {},
    status() {},
  });
  const message = { text: "Ordinary message" };
  const questions = { annotations: [{ comment: "What is this?" }] };
  const sendMessage = () => sender.send(message, () => cleared.push("message"));
  const sendQuestions = () => sender.send(questions, () => cleared.push("questions"));

  const pending = sendMessage();
  await sendQuestions();
  assert.equal(submitted.length, 1, "only one submission can be in flight");
  first.reject(new Error("Could not confirm"));
  await pending;
  assert.deepEqual(cleared, []);

  busy = true;
  assert.equal(sender.canSend(questions), false);
  assert.equal(sender.canSend(message), true);
  await sendMessage();
  assert.deepEqual(submitted, [{ ...message, requestId: "1" }, { ...message, requestId: "1" }]);
  assert.deepEqual(cleared, ["message"]);
  assert.equal(sender.accepted, 1);
});

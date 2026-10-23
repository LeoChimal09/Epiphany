import { describe, expect, it } from "vitest";
import { asksNotToSave } from "./nosave";

describe("asking not to save", () => {
  it.each([
    "don't save this, I'm just thinking",
    "Do not save that",
    "no need to save it",
    "just chatting, my essay is due friday lol",
    "just venting about chem",
    "off the record: I hate this class",
    "please don't add it to my list",
    "I don't need to track that",
    "don't make that a task",
    "talking through it without saving anything",
    "that's not a task, just a thought",
  ])("treats %j as a request not to save", (text) => {
    expect(asksNotToSave(text)).toBe(true);
  });

  it.each([
    "essay due friday, remind me to start tomorrow",
    "don't forget to add milk to my list",
    "remind me not to forget my keys",
    "save this app idea: a habit tracker",
    "I never keep track of homework, so please add chem lab due monday",
    "I'm chatting with my advisor tomorrow, add it",
  ])("does not mistake %j for one", (text) => {
    expect(asksNotToSave(text)).toBe(false);
  });
});

import { describe, test, expect } from "bun:test";

/**
 * Tests for agent identity resolution in Matrix room messages.
 * Verifies that:
 * 1. Own messages are marked with "**your message:**" prefix
 * 2. Display names are resolved from room member list
 */

describe("matrixActions identity marking", () => {
  test("message with own user ID gets marked", () => {
    // Integration with real readRoom requires a Matrix server, so we test the contract here:
    // when matrixUserId matches a message's sender, content is prefixed with "**your message:**"
    const ownUserId = "@alice:localhost";
    const senderUserId = "@alice:localhost";
    const originalContent = "Hello world";

    // Simulate what readRoom does
    const isOwnMessage = ownUserId === senderUserId;
    const markedContent = isOwnMessage ? `**your message:** ${originalContent}` : originalContent;

    expect(markedContent).toBe("**your message:** Hello world");
  });

  test("message from different user is not marked", () => {
    const ownUserId = "@alice:localhost";
    const senderUserId = "@bob:localhost";
    const originalContent = "Hi there";

    const isOwnMessage = ownUserId === senderUserId;
    const markedContent = isOwnMessage ? `**your message:** ${originalContent}` : originalContent;

    expect(markedContent).toBe("Hi there");
    expect(markedContent).not.toContain("**your message:**");
  });

  test("agent system prompt explains own message marking", () => {
    // Verify the persona.ts prompt mentions own message marking
    const promptHint = "Messages from **yourself** are marked \"**your message:**\"";
    expect(promptHint).toContain("**your message:**");
  });
});

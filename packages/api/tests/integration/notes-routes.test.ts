/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { initTestContext, runCleanup, type TestContext } from "../helpers/test-utils.js";

describe("Notes Routes Integration Tests", () => {
  let context: TestContext;
  let app: FastifyInstance;
  let user1Token: string;
  let user1Id: string;
  let user2Token: string;
  let user2Id: string;

  beforeAll(async () => {
    context = await initTestContext(2, 10000);
    app = context.app;
    user1Token = context.users[0].token;
    user1Id = context.users[0].id;
    user2Token = context.users[1].token;
    user2Id = context.users[1].id;
  });

  afterAll(async () => {
    await runCleanup(context.cleanup);
  });

  describe("POST /notes", () => {
    it("should require authentication", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/notes",
        payload: {
          targetId: user2Id,
          content: "Test note",
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it("should create a new note successfully", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          targetId: user2Id,
          content: "Aggressive player, raises often",
          label: "Shark",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.success).toBe(true);
      expect(body.note).toHaveProperty("id");
      expect(body.note.authorId).toBe(user1Id);
      expect(body.note.targetId).toBe(user2Id);
      expect(body.note.content).toBe("Aggressive player, raises often");
      expect(body.note.label).toBe("Shark");
    });

    it("should create note without label", async () => {
      // Clean up first
      await app.prisma.playerNote.deleteMany({
        where: { authorId: user1Id, targetId: user2Id },
      });

      const response = await app.inject({
        method: "POST",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          targetId: user2Id,
          content: "No label note",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.success).toBe(true);
      expect(body.note.content).toBe("No label note");
      expect(body.note.label).toBeNull();
    });

    it("should update existing note", async () => {
      // Create initial note
      await app.inject({
        method: "POST",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          targetId: user2Id,
          content: "Initial content",
          label: "Fish",
        },
      });

      // Update the note
      const response = await app.inject({
        method: "POST",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          targetId: user2Id,
          content: "Updated content",
          label: "Shark",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.note.content).toBe("Updated content");
      expect(body.note.label).toBe("Shark");
    });

    it("should reject note about yourself", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          targetId: user1Id, // Same as author
          content: "Note to self",
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("Cannot write notes on yourself");
    });

    it("should reject note exceeding 500 characters", async () => {
      const longContent = "a".repeat(501);

      const response = await app.inject({
        method: "POST",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          targetId: user2Id,
          content: longContent,
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      // Fastify's schema validation catches this first
      expect(body.message || body.error).toContain("500 characters");
    });

    it("should accept note with exactly 500 characters", async () => {
      const maxContent = "a".repeat(500);

      // Clean up first
      await app.prisma.playerNote.deleteMany({
        where: { authorId: user1Id, targetId: user2Id },
      });

      const response = await app.inject({
        method: "POST",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          targetId: user2Id,
          content: maxContent,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.note.content).toHaveLength(500);
    });

    it("should reject invalid payload", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          targetId: user2Id,
          // Missing content
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /notes/:targetId", () => {
    beforeAll(async () => {
      // Create a test note
      await app.prisma.playerNote.deleteMany({
        where: { authorId: user1Id, targetId: user2Id },
      });

      await app.inject({
        method: "POST",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          targetId: user2Id,
          content: "Test note for retrieval",
          label: "Test",
        },
      });
    });

    it("should require authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/notes/${user2Id}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("should retrieve existing note", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/notes/${user2Id}`,
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.note).toBeDefined();
      expect(body.note.targetId).toBe(user2Id);
      expect(body.note.content).toBe("Test note for retrieval");
      expect(body.note.label).toBe("Test");
    });

    it("should return null for non-existent note", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/notes/${user1Id}`, // User 1 checking note about themselves (doesn't exist)
        headers: {
          authorization: `Bearer ${user2Token}`, // User 2 making request
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.note).toBeNull();
    });
  });

  describe("GET /notes", () => {
    beforeAll(async () => {
      // Clean up and create multiple notes
      await app.prisma.playerNote.deleteMany({
        where: { authorId: user1Id },
      });

      await app.inject({
        method: "POST",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          targetId: user2Id,
          content: "Note about user 2",
          label: "Fish",
        },
      });
    });

    it("should require authentication", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/notes",
      });

      expect(response.statusCode).toBe(401);
    });

    it("should retrieve all notes by user", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.notes).toBeDefined();
      expect(Array.isArray(body.notes)).toBe(true);
      expect(body.notes.length).toBeGreaterThan(0);

      const note = body.notes[0];
      expect(note).toHaveProperty("id");
      expect(note).toHaveProperty("content");
      expect(note).toHaveProperty("label");
      expect(note).toHaveProperty("target");
      expect(note.target).toHaveProperty("id");
      expect(note.target).toHaveProperty("username");
    });

    it("should return empty array for user with no notes", async () => {
      // User 2 hasn't written any notes
      await app.prisma.playerNote.deleteMany({
        where: { authorId: user2Id },
      });

      const response = await app.inject({
        method: "GET",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user2Token}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.notes).toEqual([]);
    });
  });

  describe("DELETE /notes/:targetId", () => {
    beforeAll(async () => {
      // Create a note to delete
      await app.prisma.playerNote.deleteMany({
        where: { authorId: user1Id, targetId: user2Id },
      });

      await app.inject({
        method: "POST",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          targetId: user2Id,
          content: "Note to be deleted",
        },
      });
    });

    it("should require authentication", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/notes/${user2Id}`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("should delete existing note", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/notes/${user2Id}`,
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.success).toBe(true);
      expect(body.message).toBe("Note deleted");

      // Verify note is deleted
      const getResponse = await app.inject({
        method: "GET",
        url: `/notes/${user2Id}`,
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
      });

      const getBody = JSON.parse(getResponse.body);
      expect(getBody.note).toBeNull();
    });

    it("should return 404 when deleting non-existent note", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/notes/${user2Id}`, // Already deleted
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBe("Note not found");
    });
  });

  describe("Privacy & Isolation", () => {
    it("should keep notes private between users", async () => {
      // User 1 creates note about User 2
      await app.prisma.playerNote.deleteMany({
        where: { authorId: user1Id, targetId: user2Id },
      });

      await app.inject({
        method: "POST",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          targetId: user2Id,
          content: "Private note from User 1",
        },
      });

      // User 2 should not see User 1's note in their list
      const response = await app.inject({
        method: "GET",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user2Token}`,
        },
      });

      const body = JSON.parse(response.body);
      const notesAboutUser2ByUser1 = body.notes.filter(
        (note: any) => note.targetId === user2Id && note.authorId === user1Id
      );

      expect(notesAboutUser2ByUser1).toHaveLength(0);
    });

    it("should allow different users to have notes about same target", async () => {
      // Clean up
      await app.prisma.playerNote.deleteMany({
        where: {
          OR: [
            { authorId: user1Id, targetId: user2Id },
            { authorId: user2Id, targetId: user1Id },
          ],
        },
      });

      // User 1 creates note about User 2
      await app.inject({
        method: "POST",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
        payload: {
          targetId: user2Id,
          content: "User 1's note about User 2",
        },
      });

      // User 2 creates note about User 1
      await app.inject({
        method: "POST",
        url: "/notes",
        headers: {
          authorization: `Bearer ${user2Token}`,
        },
        payload: {
          targetId: user1Id,
          content: "User 2's note about User 1",
        },
      });

      // Verify User 1 has their note
      const user1Response = await app.inject({
        method: "GET",
        url: `/notes/${user2Id}`,
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
      });

      const user1Body = JSON.parse(user1Response.body);
      expect(user1Body.note.content).toBe("User 1's note about User 2");

      // Verify User 2 has their note
      const user2Response = await app.inject({
        method: "GET",
        url: `/notes/${user1Id}`,
        headers: {
          authorization: `Bearer ${user2Token}`,
        },
      });

      const user2Body = JSON.parse(user2Response.body);
      expect(user2Body.note.content).toBe("User 2's note about User 1");
    });
  });
});

/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotesManager } from "../../src/services/NotesManager.js";

describe("NotesManager", () => {
  let notesManager: NotesManager;
  let mockPrisma: any;

  beforeEach(() => {
    // Create mock Prisma client
    mockPrisma = {
      playerNote: {
        upsert: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        delete: vi.fn(),
      },
    };

    notesManager = new NotesManager(mockPrisma);
    vi.clearAllMocks();
  });

  describe("upsertNote", () => {
    it("should create a new note successfully", async () => {
      const authorId = "user_1";
      const targetId = "user_2";
      const content = "Aggressive player";
      const label = "Shark";

      const expectedNote = {
        id: "note_1",
        authorId,
        targetId,
        content,
        label,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.playerNote.upsert.mockResolvedValue(expectedNote);

      const result = await notesManager.upsertNote(authorId, targetId, content, label);

      expect(result).toEqual(expectedNote);
      expect(mockPrisma.playerNote.upsert).toHaveBeenCalledWith({
        where: {
          authorId_targetId: { authorId, targetId },
        },
        create: {
          authorId,
          targetId,
          content,
          label,
        },
        update: {
          content,
          label,
        },
      });
    });

    it("should update existing note", async () => {
      const authorId = "user_1";
      const targetId = "user_2";
      const newContent = "Changed playstyle";
      const newLabel = "Fish";

      const updatedNote = {
        id: "note_1",
        authorId,
        targetId,
        content: newContent,
        label: newLabel,
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date(),
      };

      mockPrisma.playerNote.upsert.mockResolvedValue(updatedNote);

      const result = await notesManager.upsertNote(authorId, targetId, newContent, newLabel);

      expect(result).toEqual(updatedNote);
      expect(mockPrisma.playerNote.upsert).toHaveBeenCalled();
    });

    it("should throw error when trying to write note about yourself", async () => {
      const userId = "user_1";
      const content = "Note to self";

      await expect(notesManager.upsertNote(userId, userId, content)).rejects.toThrow(
        "Cannot write notes on yourself"
      );

      expect(mockPrisma.playerNote.upsert).not.toHaveBeenCalled();
    });

    it("should throw error when content exceeds 500 characters", async () => {
      const authorId = "user_1";
      const targetId = "user_2";
      const longContent = "a".repeat(501);

      await expect(notesManager.upsertNote(authorId, targetId, longContent)).rejects.toThrow(
        "Note too long (max 500 chars)"
      );

      expect(mockPrisma.playerNote.upsert).not.toHaveBeenCalled();
    });

    it("should allow note with exactly 500 characters", async () => {
      const authorId = "user_1";
      const targetId = "user_2";
      const maxContent = "a".repeat(500);

      const expectedNote = {
        id: "note_1",
        authorId,
        targetId,
        content: maxContent,
        label: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.playerNote.upsert.mockResolvedValue(expectedNote);

      const result = await notesManager.upsertNote(authorId, targetId, maxContent);

      expect(result).toEqual(expectedNote);
      expect(mockPrisma.playerNote.upsert).toHaveBeenCalled();
    });

    it("should create note without label", async () => {
      const authorId = "user_1";
      const targetId = "user_2";
      const content = "No label note";

      const expectedNote = {
        id: "note_1",
        authorId,
        targetId,
        content,
        label: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.playerNote.upsert.mockResolvedValue(expectedNote);

      const result = await notesManager.upsertNote(authorId, targetId, content);

      expect(result).toEqual(expectedNote);
      expect(result.label).toBeNull();
    });
  });

  describe("getNote", () => {
    it("should retrieve existing note", async () => {
      const authorId = "user_1";
      const targetId = "user_2";

      const expectedNote = {
        id: "note_1",
        authorId,
        targetId,
        content: "Test note",
        label: "Fish",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.playerNote.findUnique.mockResolvedValue(expectedNote);

      const result = await notesManager.getNote(authorId, targetId);

      expect(result).toEqual(expectedNote);
      expect(mockPrisma.playerNote.findUnique).toHaveBeenCalledWith({
        where: {
          authorId_targetId: { authorId, targetId },
        },
      });
    });

    it("should return null if note doesn't exist", async () => {
      const authorId = "user_1";
      const targetId = "user_2";

      mockPrisma.playerNote.findUnique.mockResolvedValue(null);

      const result = await notesManager.getNote(authorId, targetId);

      expect(result).toBeNull();
    });
  });

  describe("getAllNotes", () => {
    it("should retrieve all notes by author", async () => {
      const authorId = "user_1";

      const expectedNotes = [
        {
          id: "note_1",
          authorId,
          targetId: "user_2",
          content: "Note 1",
          label: "Fish",
          createdAt: new Date(),
          updatedAt: new Date(),
          target: { id: "user_2", username: "Player2" },
        },
        {
          id: "note_2",
          authorId,
          targetId: "user_3",
          content: "Note 2",
          label: "Shark",
          createdAt: new Date(),
          updatedAt: new Date(),
          target: { id: "user_3", username: "Player3" },
        },
      ];

      mockPrisma.playerNote.findMany.mockResolvedValue(expectedNotes);

      const result = await notesManager.getAllNotes(authorId);

      expect(result).toEqual(expectedNotes);
      expect(mockPrisma.playerNote.findMany).toHaveBeenCalledWith({
        where: { authorId },
        include: {
          target: {
            select: {
              id: true,
              username: true,
            },
          },
        },
        orderBy: { updatedAt: "desc" },
      });
    });

    it("should return empty array if no notes exist", async () => {
      const authorId = "user_1";

      mockPrisma.playerNote.findMany.mockResolvedValue([]);

      const result = await notesManager.getAllNotes(authorId);

      expect(result).toEqual([]);
    });
  });

  describe("deleteNote", () => {
    it("should delete existing note", async () => {
      const authorId = "user_1";
      const targetId = "user_2";

      const existingNote = {
        id: "note_1",
        authorId,
        targetId,
        content: "To be deleted",
        label: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.playerNote.findUnique.mockResolvedValue(existingNote);
      mockPrisma.playerNote.delete.mockResolvedValue(existingNote);

      const result = await notesManager.deleteNote(authorId, targetId);

      expect(result).toEqual(existingNote);
      expect(mockPrisma.playerNote.delete).toHaveBeenCalledWith({
        where: {
          authorId_targetId: { authorId, targetId },
        },
      });
    });

    it("should throw error when deleting non-existent note", async () => {
      const authorId = "user_1";
      const targetId = "user_2";

      mockPrisma.playerNote.findUnique.mockResolvedValue(null);

      await expect(notesManager.deleteNote(authorId, targetId)).rejects.toThrow("Note not found");

      expect(mockPrisma.playerNote.delete).not.toHaveBeenCalled();
    });
  });

  describe("Edge Cases", () => {
    it("should handle special characters in content", async () => {
      const authorId = "user_1";
      const targetId = "user_2";
      const content = "Player uses emojis 🎰🃏 and symbols @#$%";

      const expectedNote = {
        id: "note_1",
        authorId,
        targetId,
        content,
        label: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.playerNote.upsert.mockResolvedValue(expectedNote);

      const result = await notesManager.upsertNote(authorId, targetId, content);

      expect(result.content).toBe(content);
    });

    it("should handle empty content string (but valid)", async () => {
      const authorId = "user_1";
      const targetId = "user_2";
      const content = "";

      const expectedNote = {
        id: "note_1",
        authorId,
        targetId,
        content,
        label: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.playerNote.upsert.mockResolvedValue(expectedNote);

      const result = await notesManager.upsertNote(authorId, targetId, content);

      expect(result.content).toBe("");
    });
  });
});

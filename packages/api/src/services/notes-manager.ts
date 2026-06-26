import { PrismaClient } from "../../generated/prisma/index.js";
import { AppError } from "../utils/errors.js";

export class NotesManager {
  constructor(private prisma: PrismaClient) {}

  async upsertNote(authorId: string, targetId: string, content: string, label?: string) {
    if (authorId === targetId) {
      throw new AppError("Cannot write notes on yourself", 400);
    }

    if (content.length > 500) {
      throw new AppError("Note too long (max 500 chars)", 400);
    }

    return this.prisma.playerNote.upsert({
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
  }

  async getNote(authorId: string, targetId: string) {
    return this.prisma.playerNote.findUnique({
      where: {
        authorId_targetId: { authorId, targetId },
      },
    });
  }

  async getAllNotes(authorId: string) {
    return this.prisma.playerNote.findMany({
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
  }

  async deleteNote(authorId: string, targetId: string) {
    const note = await this.prisma.playerNote.findUnique({
      where: {
        authorId_targetId: { authorId, targetId },
      },
    });

    if (!note) {
      throw new AppError("Note not found", 404);
    }

    return this.prisma.playerNote.delete({
      where: {
        authorId_targetId: { authorId, targetId },
      },
    });
  }
}

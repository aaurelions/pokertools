import type { FastifyPluginAsync } from "fastify";
import {
  DeleteNoteResponseSchema,
  GetNoteResponseSchema,
  GetNotesResponseSchema,
  PlayerNoteRequestSchema,
  SavePlayerNoteResponseSchema,
  type PlayerNoteRequest,
} from "@pokertools/types";

interface NoteRecord {
  id: string;
  authorId: string;
  targetId: string;
  content: string;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
  target?: { id: string; username: string };
}

/** Project a Prisma note row onto the canonical wire shape (ISO timestamps). */
function toWireNote(note: NoteRecord) {
  return {
    id: note.id,
    authorId: note.authorId,
    targetId: note.targetId,
    content: note.content,
    label: note.label,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
    ...(note.target ? { target: note.target } : {}),
  };
}

export const notesRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /notes - Save or update note
  fastify.post<{ Body: PlayerNoteRequest }>(
    "/",
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { userId } = request.user;
      const validation = PlayerNoteRequestSchema.safeParse(request.body);

      if (!validation.success) {
        return reply.code(400).send({
          error: "Validation failed",
          message: validation.error.issues.map((issue) => issue.message).join("; "),
          details: validation.error.issues,
        });
      }

      const { targetId, content, label } = validation.data;

      try {
        const note = await fastify.notesManager.upsertNote(userId, targetId, content, label);
        return SavePlayerNoteResponseSchema.parse({
          success: true,
          note: toWireNote(note),
        });
      } catch (error) {
        if (error instanceof Error) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    }
  );

  // GET /notes/:targetId - Get note for specific player
  fastify.get<{ Params: { targetId: string } }>(
    "/:targetId",
    {
      onRequest: [fastify.authenticate],
    },
    async (request) => {
      const { userId } = request.user;
      const { targetId } = request.params;

      const note = await fastify.notesManager.getNote(userId, targetId);
      return GetNoteResponseSchema.parse({
        note: note ? toWireNote(note) : null,
      });
    }
  );

  // GET /notes - Get all notes by authenticated user
  fastify.get(
    "/",
    {
      onRequest: [fastify.authenticate],
    },
    async (request) => {
      const { userId } = request.user;

      const notes = await fastify.notesManager.getAllNotes(userId);
      return GetNotesResponseSchema.parse({
        notes: notes.map(toWireNote),
      });
    }
  );

  // DELETE /notes/:targetId - Delete note for specific player
  fastify.delete<{ Params: { targetId: string } }>(
    "/:targetId",
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const { userId } = request.user;
      const { targetId } = request.params;

      try {
        await fastify.notesManager.deleteNote(userId, targetId);
        return DeleteNoteResponseSchema.parse({ success: true, message: "Note deleted" });
      } catch (error) {
        if (error instanceof Error) {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
    }
  );
};

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const NoteSchema = z.object({
  targetId: z.string(),
  content: z.string().max(500),
  label: z.string().max(100).optional(),
});

export const notesRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /notes - Save or update note
  fastify.post<{ Body: z.infer<typeof NoteSchema> }>(
    "/",
    {
      onRequest: [fastify.authenticate],
      schema: {
        body: {
          type: "object",
          required: ["targetId", "content"],
          properties: {
            targetId: { type: "string" },
            content: { type: "string", maxLength: 500 },
            label: { type: "string", maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.user;
      const validation = NoteSchema.safeParse(request.body);

      if (!validation.success) {
        return reply.code(400).send({
          error: "Validation failed",
          details: validation.error.issues,
        });
      }

      const { targetId, content, label } = validation.data;

      try {
        const note = await fastify.notesManager.upsertNote(userId, targetId, content, label);
        return { success: true, note };
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
      return { note };
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
      return { notes };
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
        return { success: true, message: "Note deleted" };
      } catch (error) {
        if (error instanceof Error) {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
    }
  );
};

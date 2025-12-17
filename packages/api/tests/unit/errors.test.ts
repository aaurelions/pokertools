/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect } from "vitest";
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ValidationError,
  ConflictError,
  InsufficientFundsError,
} from "../../src/utils/errors.js";

describe("Error Classes", () => {
  it("should create AppError with correct properties", () => {
    const error = new AppError("Test error", 500, "TEST_ERROR");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toBe("Test error");
    expect(error.statusCode).toBe(500);
    expect(error.code).toBe("TEST_ERROR");
    expect(error.name).toBe("AppError");
    expect(error.stack).toBeDefined();
  });

  it("should create AppError with default statusCode", () => {
    const error = new AppError("Test error");

    expect(error.statusCode).toBe(500);
    expect(error.code).toBeUndefined();
  });

  it("should create AuthenticationError with correct properties", () => {
    const error = new AuthenticationError();

    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toBe("Authentication failed");
    expect(error.statusCode).toBe(401);
    expect(error.code).toBe("AUTH_FAILED");
  });

  it("should create AuthenticationError with custom message", () => {
    const error = new AuthenticationError("Invalid token");

    expect(error.message).toBe("Invalid token");
    expect(error.statusCode).toBe(401);
    expect(error.code).toBe("AUTH_FAILED");
  });

  it("should create AuthorizationError with correct properties", () => {
    const error = new AuthorizationError();

    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toBe("Insufficient permissions");
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe("FORBIDDEN");
  });

  it("should create AuthorizationError with custom message", () => {
    const error = new AuthorizationError("Access denied");

    expect(error.message).toBe("Access denied");
    expect(error.statusCode).toBe(403);
  });

  it("should create NotFoundError with correct properties", () => {
    const error = new NotFoundError();

    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toBe("Resource not found");
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("NOT_FOUND");
  });

  it("should create NotFoundError with custom resource", () => {
    const error = new NotFoundError("User");

    expect(error.message).toBe("User not found");
    expect(error.statusCode).toBe(404);
  });

  it("should create ValidationError with correct properties", () => {
    const error = new ValidationError("Invalid input");

    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toBe("Invalid input");
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("should create ConflictError with correct properties", () => {
    const error = new ConflictError("Duplicate entry");

    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toBe("Duplicate entry");
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("CONFLICT");
  });

  it("should create InsufficientFundsError with correct properties", () => {
    const error = new InsufficientFundsError();

    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toBe("Insufficient funds");
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("should create InsufficientFundsError with custom message", () => {
    const error = new InsufficientFundsError("Not enough balance");

    expect(error.message).toBe("Not enough balance");
    expect(error.statusCode).toBe(400);
  });

  it("should maintain error stack trace", () => {
    try {
      throw new ValidationError("Test validation");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).stack).toContain("errors.test.ts");
    }
  });
});

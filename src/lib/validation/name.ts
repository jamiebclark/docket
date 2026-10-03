import { z } from "zod";

export const personNameSchema = z
  .string()
  .trim()
  .min(1, { error: "Name is required" })
  .max(100, { error: "Name must be at most 100 characters" });

export const projectNameSchema = z
  .string()
  .trim()
  .min(1, { error: "Project name is required" })
  .max(80, { error: "Project name must be at most 80 characters" });

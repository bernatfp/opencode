import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { SecureInput } from "../../secure-input"
import z from "zod"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const SecureInputRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List pending secure input requests",
        description: "Get all pending secure input (password) requests across all sessions.",
        operationId: "secureInput.list",
        responses: {
          200: {
            description: "List of pending secure input requests",
            content: {
              "application/json": {
                schema: resolver(SecureInput.Request.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const requests = await SecureInput.list()
        return c.json(requests)
      },
    )
    .get(
      "/session/:sessionID",
      describeRoute({
        summary: "List pending secure input requests for session",
        description: "Get all pending secure input requests for a specific session.",
        operationId: "secureInput.listForSession",
        responses: {
          200: {
            description: "List of pending secure input requests for the session",
            content: {
              "application/json": {
                schema: resolver(SecureInput.Request.array()),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: z.string(),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const requests = await SecureInput.listForSession(params.sessionID)
        return c.json(requests)
      },
    )
    .post(
      "/:requestID/submit",
      describeRoute({
        summary: "Submit secure input",
        description:
          "Submit a password or other secure input for a pending request. The input goes directly to the PTY and is never stored or logged.",
        operationId: "secureInput.submit",
        responses: {
          200: {
            description: "Secure input submitted successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          requestID: z.string(),
        }),
      ),
      validator(
        "json",
        z.object({
          input: z.string().describe("The secure input (password) to submit"),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const json = c.req.valid("json")
        await SecureInput.submit(params.requestID, json.input)
        return c.json(true)
      },
    )
    .post(
      "/:requestID/cancel",
      describeRoute({
        summary: "Cancel secure input request",
        description: "Cancel a pending secure input request. This will send Ctrl+C to the underlying process.",
        operationId: "secureInput.cancel",
        responses: {
          200: {
            description: "Secure input request cancelled successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          requestID: z.string(),
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await SecureInput.cancel(params.requestID)
        return c.json(true)
      },
    ),
)

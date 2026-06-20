/**
 * The Judge's one external seam: a narrow, provider-neutral model port
 * (S3, spec section 2b).
 *
 * System + user text in, text out, plus an opaque model id. It carries no
 * thinking, no effort, no tools, no streaming, no token usage: those are
 * production-adapter concerns that would leak the harness's model into the
 * judgment logic if they crossed the port. Parsing, vocabulary enforcement, and
 * anchor validation live above the port, inside the Judge, so the only thing
 * that varies across the seam is "how do you turn a prompt into a string,"
 * which is exactly what production and test differ on.
 */
export interface JudgeModelPort {
  complete(request: JudgeModelRequest): Promise<JudgeModelResponse>;
}

export interface JudgeModelRequest {
  /** The rubric/instruction prompt the Judge built (version-pinned). */
  readonly system: string;
  /** The rendered content projection. */
  readonly user: string;
  /** An optional structured-output hint the production adapter may pass on. */
  readonly responseSchema?: unknown;
}

export interface JudgeModelResponse {
  /** Raw model output; the Judge parses and validates it. */
  readonly text: string;
  /** Which model answered; flows up into provenance.judgeModel. */
  readonly model: string;
}

/**
 * API re-export of the shared compiled convergence evidence.
 *
 * The record lives in `@pokertools/types` so the API and the isolated custody
 * process evaluate exactly the same release evidence. It is updated only as
 * part of the reviewed final convergence commit; while `status` is `PENDING`
 * readiness/admission stays fail-closed.
 */

export {
  CONVERGENCE_EVIDENCE,
  isConvergenceVerified,
  type ConvergenceEvidence,
} from "@pokertools/types";
